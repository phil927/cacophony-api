/*
cacophony-api: The Cacophony Project API server
Copyright (C) 2018  The Cacophony Project

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published
by the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/

import jsonwebtoken from "jsonwebtoken";
import mime from "mime";
import moment, { Moment } from "moment";
import urljoin from "url-join";
import { ClientError } from "../customErrors";
import config from "../../config";
import log from "../../logging";
import models from "../../models";
import responseUtil from "./responseUtil";
import util from "./util";
import { Response } from "express";
import {
  AudioRecordingMetadata,
  Recording,
  RecordingId,
  RecordingPermission,
  RecordingType,
  SpeciesClassification,
  TagMode
} from "../../models/Recording";
import { Event } from "../../models/Event";
import { User } from "../../models/User";
import { Order } from "sequelize";
import { FileId } from "../../models/File";
import {
  DeviceVisits,
  VisitEvent,
  DeviceVisitMap,
  Visit,
  isWithinVisitInterval
} from "./Visits";

export interface RecordingQuery {
  user: User;
  query: {
    where: null | any;
    tagMode: null | TagMode;
    tags: null | string[];
    offset: null | number;
    limit: null | number;
    order: null | Order;
    distinct: boolean;
  };
  filterOptions: null | any;
}

function makeUploadHandler(mungeData?: (any) => any) {
  return util.multipartUpload("raw", (request, data, key) => {
    if (mungeData) {
      data = mungeData(data);
    }

    const recording = models.Recording.buildSafely(data);
    recording.rawFileKey = key;
    recording.rawMimeType = guessRawMimeType(data.type, data.filename);
    recording.DeviceId = request.device.id;
    recording.GroupId = request.device.GroupId;
    recording.processingState = models.Recording.processingStates[data.type][0];
    if (typeof request.device.public === "boolean") {
      recording.public = request.device.public;
    }
    return recording;
  });
}

// Returns a promise for the recordings query specified in the
// request.
async function query(
  request: RecordingQuery,
  type?
): Promise<{ rows: Recording[]; count: number }> {
  if (type) {
    request.query.where.type = type;
  }

  const builder = await new models.Recording.queryBuilder().init(
    request.user,
    request.query.where,
    request.query.tagMode,
    request.query.tags,
    request.query.offset,
    request.query.limit,
    request.query.order
  );
  builder.query.distinct = true;
  const result = await models.Recording.findAndCountAll(builder.get());

  // This gives less location precision if the user isn't admin.
  const filterOptions = models.Recording.makeFilterOptions(
    request.user,
    request.filterOptions
  );
  result.rows = result.rows.map((rec) => {
    rec.filterData(filterOptions);
    return handleLegacyTagFieldsForGetOnRecording(rec);
  });
  return result;
}

// Returns a promise for report rows for a set of recordings. Takes
// the same parameters as query() above.
async function report(request) {
  if (request.query.type == "visits") {
    return reportVisits(request);
  }
  return reportRecordings(request);
}

async function reportRecordings(request) {
  const builder = (
    await new models.Recording.queryBuilder().init(
      request.user,
      request.query.where,
      request.query.tagMode,
      request.query.tags,
      request.query.offset,
      request.query.limit,
      request.query.order
    )
  )
    .addColumn("comment")
    .addColumn("additionalMetadata")
    .addAudioEvents();

  // NOTE: Not even going to try to attempt to add typing info to this bundle
  //  of properties...
  const result: any[] = await models.Recording.findAll(builder.get());

  const filterOptions = models.Recording.makeFilterOptions(
    request.user,
    request.filterOptions
  );

  // Our DB schema doesn't allow us to easily get from a audio event
  // recording to a audio file name so do some work first to look these up.
  const audioEvents: Map<
    RecordingId,
    { timestamp: Date; volume: number; fileId: FileId }
  > = new Map();
  const audioFileIds: Set<number> = new Set();
  for (const r of result) {
    const event = findLatestEvent(r.Device.Events);
    if (event) {
      const fileId = event.EventDetail.details.fileId;
      audioEvents[r.id] = {
        timestamp: event.dateTime,
        volume: event.EventDetail.details.volume,
        fileId
      };
      audioFileIds.add(fileId);
    }
  }

  // Bulk look up file details of played audio events.
  const audioFileNames = new Map();
  for (const f of await models.File.getMultiple(Array.from(audioFileIds))) {
    audioFileNames[f.id] = f.details.name;
  }

  const recording_url_base = config.server.recording_url_base || "";

  const out = [
    [
      "Id",
      "Type",
      "Group",
      "Device",
      "Date",
      "Time",
      "Latitude",
      "Longitude",
      "Duration",
      "BatteryPercent",
      "Comment",
      "Track Count",
      "Automatic Track Tags",
      "Human Track Tags",
      "Recording Tags",
      "Audio Bait",
      "Audio Bait Time",
      "Mins Since Audio Bait",
      "Audio Bait Volume",
      "URL",
      "Cacophony Index",
      "Species Classification"
    ]
  ];

  for (const r of result) {
    r.filterData(filterOptions);

    const automatic_track_tags = new Set();
    const human_track_tags = new Set();
    for (const track of r.Tracks) {
      for (const tag of track.TrackTags) {
        const subject = tag.what || tag.detail;
        if (tag.automatic) {
          automatic_track_tags.add(subject);
        } else {
          human_track_tags.add(subject);
        }
      }
    }

    const recording_tags = r.Tags.map((t) => t.what || t.detail);

    let audioBaitName = "";
    let audioBaitTime = null;
    let audioBaitDelta = null;
    let audioBaitVolume = null;
    const audioEvent = audioEvents[r.id];
    if (audioEvent) {
      audioBaitName = audioFileNames[audioEvent.fileId];
      audioBaitTime = moment(audioEvent.timestamp);
      audioBaitDelta = moment
        .duration(r.recordingDateTime - audioBaitTime)
        .asMinutes()
        .toFixed(1);
      audioBaitVolume = audioEvent.volume;
    }

    const cacophonyIndex = getCacophonyIndex(r);
    const speciesClassifications = getSpeciesIdentification(r);

    out.push([
      r.id,
      r.type,
      r.Group.groupname,
      r.Device.devicename,
      moment(r.recordingDateTime).tz(config.timeZone).format("YYYY-MM-DD"),
      moment(r.recordingDateTime).tz(config.timeZone).format("HH:mm:ss"),
      r.location ? r.location.coordinates[0] : "",
      r.location ? r.location.coordinates[1] : "",
      r.duration,
      r.batteryLevel,
      r.comment,
      r.Tracks.length,
      formatTags(automatic_track_tags),
      formatTags(human_track_tags),
      formatTags(recording_tags),
      audioBaitName,
      audioBaitTime ? audioBaitTime.tz(config.timeZone).format("HH:mm:ss") : "",
      audioBaitDelta,
      audioBaitVolume,
      urljoin(recording_url_base, r.id.toString()),
      cacophonyIndex,
      speciesClassifications
    ]);
  }
  return out;
}

function getCacophonyIndex(recording: Recording): string | null {
  return (recording.additionalMetadata as AudioRecordingMetadata)?.analysis?.cacophony_index
    ?.map((val) => val.index_percent)
    .join(";");
}

function getSpeciesIdentification(recording: Recording): string | null {
  return (recording.additionalMetadata as AudioRecordingMetadata)?.analysis?.species_identify
    ?.map(
      (classification) => `${classification.species}: ${classification.begin_s}`
    )
    .join(";");
}

function findLatestEvent(events: Event[]): Event | null {
  if (!events) {
    return null;
  }

  let latest = events[0];
  for (const event of events) {
    if (event.dateTime > latest.dateTime) {
      latest = event;
    }
  }
  return latest;
}

function formatTags(tags) {
  const out = Array.from(tags);
  out.sort();
  return out.join("+");
}

async function get(request, type?: RecordingType) {
  const recording = await models.Recording.get(
    request.user,
    request.params.id,
    RecordingPermission.VIEW,
    {
      type,
      filterOptions: request.query.filterOptions
    }
  );
  if (!recording) {
    throw new ClientError("No file found with given datapoint.");
  }

  const data: any = {
    recording: handleLegacyTagFieldsForGetOnRecording(recording)
  };

  if (recording.fileKey) {
    data.cookedJWT = jsonwebtoken.sign(
      {
        _type: "fileDownload",
        key: recording.fileKey,
        filename: recording.getFileName(),
        mimeType: recording.fileMimeType
      },
      config.server.passportSecret,
      { expiresIn: 60 * 10 }
    );
    data.cookedSize = await util.getS3ObjectFileSize(recording.fileKey);
  }

  if (recording.rawFileKey) {
    data.rawJWT = jsonwebtoken.sign(
      {
        _type: "fileDownload",
        key: recording.rawFileKey,
        filename: recording.getRawFileName(),
        mimeType: recording.rawMimeType
      },
      config.server.passportSecret,
      { expiresIn: 60 * 10 }
    );
    data.rawSize = await util.getS3ObjectFileSize(recording.rawFileKey);
  }

  delete data.recording.rawFileKey;
  delete data.recording.fileKey;

  return data;
}

async function delete_(request, response) {
  const deleted: Recording = await models.Recording.deleteOne(
    request.user,
    request.params.id
  );
  if (deleted === null) {
    return responseUtil.send(response, {
      statusCode: 400,
      messages: ["Failed to delete recording."]
    });
  }
  if (deleted.rawFileKey) {
    util.deleteS3Object(deleted.rawFileKey).catch((err) => {
      log.warn(err);
    });
  }
  if (deleted.fileKey) {
    util.deleteS3Object(deleted.fileKey).catch((err) => {
      log.warn(err);
    });
  }
  responseUtil.send(response, {
    statusCode: 200,
    messages: ["Deleted recording."]
  });
}

function guessRawMimeType(type, filename) {
  const mimeType = mime.getType(filename);
  if (mimeType) {
    return mimeType;
  }
  switch (type) {
    case "thermalRaw":
      return "application/x-cptv";
    case "audio":
      return "audio/mpeg";
    default:
      return "application/octet-stream";
  }
}

async function addTag(user, recording, tag, response) {
  if (!recording) {
    throw new ClientError("No such recording.");
  }

  // If old tag fields are used, convert to new field names.
  tag = handleLegacyTagFieldsForCreate(tag);

  const tagInstance = models.Tag.buildSafely(tag);
  tagInstance.RecordingId = recording.id;
  if (user) {
    tagInstance.taggerId = user.id;
  }
  await tagInstance.save();

  responseUtil.send(response, {
    statusCode: 200,
    messages: ["Added new tag."],
    tagId: tagInstance.id
  });
}

function handleLegacyTagFieldsForCreate(tag) {
  tag = moveLegacyField(tag, "animal", "what");
  tag = moveLegacyField(tag, "event", "detail");
  return tag;
}

function moveLegacyField(o, oldName, newName) {
  if (o[oldName]) {
    if (o[newName]) {
      throw new ClientError(
        `can't specify both '${oldName}' and '${newName}' fields at the same time`
      );
    }
    o[newName] = o[oldName];
    delete o[oldName];
  }
  return o;
}

function handleLegacyTagFieldsForGet(tag) {
  tag.animal = tag.what;
  tag.event = tag.detail;
  return tag;
}

function handleLegacyTagFieldsForGetOnRecording(recording) {
  recording = recording.get({ plain: true });
  recording.Tags = recording.Tags.map(handleLegacyTagFieldsForGet);
  return recording;
}

const statusCode = {
  Success: 1,
  Fail: 2,
  Both: 3
};

// reprocessAll expects request.body.recordings to be a list of recording_ids
// will mark each recording to be reprocessed
async function reprocessAll(request, response) {
  const recordings = request.body.recordings;
  const responseMessage = {
    statusCode: 200,
    messages: [],
    reprocessed: [],
    fail: []
  };

  let status = 0;
  for (let i = 0; i < recordings.length; i++) {
    const resp = await reprocessRecording(request.user, recordings[i]);
    if (resp.statusCode != 200) {
      status = status | statusCode.Fail;
      responseMessage.messages.push(resp.messages[0]);
      responseMessage.statusCode = resp.statusCode;
      responseMessage.fail.push(resp.recordingId);
    } else {
      responseMessage.reprocessed.push(resp.recordingId);
      status = status | statusCode.Success;
    }
  }
  responseMessage.messages.splice(0, 0, getReprocessMessage(status));
  responseUtil.send(response, responseMessage);
  return;
}

function getReprocessMessage(status) {
  switch (status) {
    case statusCode.Success:
      return "All recordings scheduled for reprocessing";
    case statusCode.Fail:
      return "Recordings could not be scheduled for reprocessing";
    case statusCode.Both:
      return "Some recordings could not be scheduled for reprocessing";
    default:
      return "";
  }
}

// reprocessRecording marks supplied recording_id for reprocessing,
// under supplied user privileges
async function reprocessRecording(user, recording_id) {
  const recording = await models.Recording.get(
    user,
    recording_id,
    RecordingPermission.UPDATE
  );

  if (!recording) {
    return {
      statusCode: 400,
      messages: ["No such recording: " + recording_id],
      recordingId: recording_id
    };
  }

  await recording.reprocess(user);

  return {
    statusCode: 200,
    messages: ["Recording scheduled for reprocessing"],
    recordingId: recording_id
  };
}

// reprocess a recording defined by request.user and request.params.id
async function reprocess(request, response: Response) {
  const responseInfo = await reprocessRecording(
    request.user,
    request.params.id
  );
  responseUtil.send(response, responseInfo);
}

async function updateMetadata(recording: any, metadata: any) {
  throw new Error("recordingUtil.updateMetadata is unimplemented!");
}

// generates new visits and returns a tuple of completeVisits and incompleteVisits
function generateVisits(
  deviceMap: DeviceVisitMap,
  recordings: any[],
  filterOptions,
  queryOffset: number,
  userId: number,
  gotAllRecordings: boolean
): [Visit[], Visit[]] {
  let visits: Visit[] = [];
  let incompleteVisits: Visit[] = [];
  for (const [i, rec] of recordings.entries()) {
    rec.filterData(filterOptions);

    let devVisits = deviceMap[rec.DeviceId];
    if (!devVisits) {
      devVisits = new DeviceVisits(
        rec.Device.devicename,
        rec.Group.groupname,
        rec.DeviceId,
        userId
      );
      deviceMap[rec.DeviceId] = devVisits;
    }
    const newVisits = devVisits.calculateNewVisits(
      rec,
      queryOffset + i,
      gotAllRecordings
    );
    if (gotAllRecordings) {
      visits.push(...newVisits);
    } else {
      incompleteVisits.push(...newVisits);
    }
  }

  return [visits, incompleteVisits];
}
// Returns a promise for the recordings visits query specified in the
// request.
async function queryVisits(
  request: RecordingQuery,
  type?
): Promise<{
  visits: Visit[];
  rows: DeviceVisitMap;
  hasMoreVisits: boolean;
  queryOffset: number;
  totalRecordings: number;
  numRecordings: number;
  numVisits: number;
}> {
  const maxVisitQueryResults = 5000;
  const requestVisits =
    request.query.limit == null
      ? maxVisitQueryResults
      : (request.query.limit as number);
  let queryMax = maxVisitQueryResults * 2;
  let queryLimit = queryMax;
  if (request.query.limit) {
    queryLimit = Math.min(request.query.limit * 2, queryMax);
  }
  const builder = await new models.Recording.queryBuilder().init(
    request.user,
    request.query.where,
    request.query.tagMode,
    request.query.tags,
    request.query.offset,
    queryLimit,
    null
  );
  builder.query.distinct = true;
  builder.addAudioEvents(
    '"Recording"."recordingDateTime" - interval \'1 day\'',
    '"Recording"."recordingDateTime" + interval \'1 day\''
  );

  const audioFileIds: Set<number> = new Set();
  const deviceMap: DeviceVisitMap = {};
  let visits: Visit[] = [];
  const filterOptions = models.Recording.makeFilterOptions(
    request.user,
    request.filterOptions
  );
  let numRecordings = 0;
  let remainingVisits = requestVisits;
  let incompleteVisits: Visit[] = [];
  let totalCount, recordings, gotAllRecordings;

  while (gotAllRecordings || remainingVisits > 0) {
    if (totalCount) {
      recordings = await models.Recording.findAll(builder.get());
    } else {
      const result = await models.Recording.findAndCountAll(builder.get());
      totalCount = result.count;
      recordings = result.rows;
    }

    numRecordings += recordings.length;
    gotAllRecordings = recordings.length + builder.query.offset >= recordings;
    if (recordings.length == 0) {
      break;
    }

    const [newVisits, newIncomplete] = generateVisits(
      deviceMap,
      recordings,
      filterOptions,
      request.query.offset || 0,
      request.user.id,
      gotAllRecordings
    );
    visits.push(...newVisits);
    incompleteVisits.push(...newIncomplete);

    if (!gotAllRecordings) {
      const lastRecStart = moment(
        recordings[recordings.length - 1].recordingDateTime
      );

      incompleteVisits = checkForCompleteVisits(
        visits,
        incompleteVisits,
        lastRecStart
      );
    }

    remainingVisits = requestVisits - visits.length;
    builder.query.limit = Math.min(remainingVisits * 2, queryMax);
    builder.query.offset += recordings.length;
  }

  let queryOffset = 0;
  // mark all as complete
  if (gotAllRecordings) {
    incompleteVisits.forEach((elem) => {
      elem.incomplete = false;
    });

    visits.push(...incompleteVisits);
    incompleteVisits = [];
  }

  // remove incomplete visits and get all audio file ids
  for (const device in deviceMap) {
    const deviceVisits = deviceMap[device];
    deviceVisits.audioFileIds.forEach((id) => audioFileIds.add(id));
    if (!gotAllRecordings) {
      deviceVisits.removeIncompleteVisits();
    }
    if (deviceVisits.visitCount == 0) {
      delete deviceMap[device];
    }
  }

  // get the offset to use for future queries
  if (incompleteVisits.length > 0) {
    queryOffset = incompleteVisits[0].queryOffset;
  } else if (visits.length > 0) {
    queryOffset = visits[visits.length - 1].queryOffset + 1;
  }

  visits = visits.filter((v) => !v.incomplete);

  // Bulk look up file details of played audio events.
  const audioFileNames = new Map();
  for (const f of await models.File.getMultiple(Array.from(audioFileIds))) {
    audioFileNames[f.id] = f.details.name;
  }

  // this updates the references in deviceMap
  for (const visit of visits) {
    for (const audioEvent of visit.audioBaitEvents) {
      audioEvent.dataValues.fileName =
        audioFileNames[audioEvent.EventDetail.details.fileId];
    }
  }

  return {
    visits: visits,
    rows: deviceMap,
    hasMoreVisits: !gotAllRecordings,
    totalRecordings: totalCount,
    queryOffset: queryOffset,
    numRecordings: numRecordings,
    numVisits: visits.length
  };
}

function reportDeviceVisits(deviceMap: DeviceVisitMap) {
  const device_summary_out = [
    [
      "Device ID",
      "Device Name",
      "Group Name",
      "First Visit",
      "Last Visit",
      "# Visits",
      "Avg Events per Visit",
      "Animal",
      "Visits",
      "Using Audio Bait",
      "", //needed for visits columns to show
      "",
      ""
    ]
  ];
  const eventSum = (accumulator, visit) => accumulator + visit.events.length;
  for (const deviceId in deviceMap) {
    const deviceVisits = deviceMap[deviceId];
    device_summary_out.push([
      deviceId,
      deviceVisits.deviceName,
      deviceVisits.groupName,
      deviceVisits.startTime.tz(config.timeZone).format("HH:mm:ss"),
      deviceVisits.endTime.tz(config.timeZone).format("HH:mm:ss"),
      deviceVisits.visitCount.toString(),
      (
        Math.round((10 * deviceVisits.eventCount) / deviceVisits.visitCount) /
        10
      ).toString(),
      Object.keys(deviceVisits.animals).join(";"),
      Object.values(deviceVisits.animals)
        .map((vis) => vis.visits.length)
        .join(";"),
      deviceVisits.audioBait.toString()
    ]);

    for (const [animal, visitSummary] of Object.entries(deviceVisits.animals)) {
      device_summary_out.push([
        deviceId,
        deviceVisits.deviceName,
        deviceVisits.groupName,
        visitSummary.start.tz(config.timeZone).format("HH:mm:ss"),
        visitSummary.end.tz(config.timeZone).format("HH:mm:ss"),
        visitSummary.visits.length.toString(),
        (
          Number(visitSummary.visits.reduce(eventSum, 0)) /
          visitSummary.visits.length
        ).toString(),
        animal,
        visitSummary.visits.length.toString(),
        deviceVisits.audioBait.toString()
      ]);
    }
  }
  return device_summary_out;
}

async function reportVisits(request) {
  const results = await queryVisits(request);
  const out = reportDeviceVisits(results.rows);
  const recordingUrlBase = config.server.recording_url_base || "";
  out.push([]);
  out.push([
    "Visit ID",
    "Group",
    "Device",
    "Type",
    "What",
    "Rec ID",
    "Date",
    "Start",
    "End",
    "Confidence",
    "# Events",
    "Audio Played",
    "URL"
  ]);

  for (const visit of results.visits) {
    addVisitRow(out, visit);

    const audioEvents = visit.audioBaitEvents.sort(function (a, b) {
      return moment(a.dateTime) > moment(b.dateTime) ? 1 : -1;
    });

    let audioEvent = audioEvents.pop();
    let audioTime, audioBaitBefore;
    if (audioEvent) {
      audioTime = moment(audioEvent.dateTime);
    }
    // add visit events and audio bait in descending order
    for (const event of visit.events) {
      audioBaitBefore = audioTime && audioTime.isAfter(event.start);
      while (audioBaitBefore) {
        addAudioBaitRow(out, visit, audioEvent);
        audioEvent = audioEvents.pop();
        if (audioEvent) {
          audioTime = moment(audioEvent.dateTime);
        }
        audioBaitBefore = audioTime && audioTime.isAfter(event.start);
      }
      addEventRow(out, visit, event, recordingUrlBase);
    }
    if (audioEvent) {
      audioEvents.push(audioEvent);
    }
    for (const audioEvent of audioEvents.reverse()) {
      addAudioBaitRow(out, visit, audioEvent);
    }
  }
  return out;
}

function addVisitRow(out, visit) {
  out.push([
    visit.visitID.toString(),
    visit.deviceName,
    visit.groupName,
    "Visit",
    visit.what,
    "",
    visit.start.tz(config.timeZone).format("YYYY-MM-DD"),
    visit.start.tz(config.timeZone).format("HH:mm:ss"),
    visit.end.tz(config.timeZone).format("HH:mm:ss"),
    "",
    visit.events.length.toString(),
    visit.audioBaitVisit.toString(),
    ""
  ]);
}

function addEventRow(out, visit, event, recordingUrlBase) {
  out.push([
    "",
    "",
    "",
    "Event",
    event.what,
    event.recID.toString(),
    event.start.tz(config.timeZone).format("YYYY-MM-DD"),
    event.start.tz(config.timeZone).format("HH:mm:ss"),

    event.end.tz(config.timeZone).format("HH:mm:ss"),
    event.confidence + "%",
    "",
    "",
    urljoin(recordingUrlBase, event.recID.toString(), event.trackID.toString())
  ]);
}

function addAudioBaitRow(out, visit, audioBait) {
  let audioPlayed = audioBait.dataValues.fileName;
  if (audioBait.EventDetail.details.volume) {
    audioPlayed += " vol " + audioBait.EventDetail.details.volume;
  }
  out.push([
    "",
    "",
    "",
    "Audio Bait",
    audioBait.dataValues.fileName,
    "",
    moment(audioBait.dateTime).tz(config.timeZone).format("YYYY-MM-DD"),
    moment(audioBait.dateTime).tz(config.timeZone).format("HH:mm:ss"),
    "",
    "",
    "",
    audioPlayed,
    ""
  ]);
}

// any visits which have started more than the visit interval from firstStart are marked as completed
// any remaining incomplete visits are returned
function checkForCompleteVisits(
  visits: Visit[],
  incompleteVisits: Visit[],
  firstStart: Moment
): Visit[] {
  let stillIncomplete: Visit[] = [];
  for (const newVisit of incompleteVisits) {
    if (isWithinVisitInterval(newVisit.start, firstStart)) {
      stillIncomplete.push(newVisit);
    } else {
      newVisit.incomplete = false;
      visits.push(newVisit);
    }
  }
  return stillIncomplete;
}

export default {
  makeUploadHandler,
  query,
  report,
  get,
  delete_,
  addTag,
  reprocess,
  reprocessAll,
  updateMetadata,
  queryVisits
};

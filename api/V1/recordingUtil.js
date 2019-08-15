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

const jsonwebtoken = require("jsonwebtoken");
const mime = require("mime");
const sequelize = require("sequelize");
const Op = sequelize.Op;
const moment = require("moment");
const urljoin = require("url-join");

const { ClientError } = require("../customErrors");
const config = require("../../config");
const models = require("../../models");
const responseUtil = require("./responseUtil");
const util = require("./util");

function makeUploadHandler(mungeData) {
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
async function query(request, type) {
  if (!request.query.where) {
    request.query.where = {};
  }
  if (type) {
    request.query.where.type = type;
  }

  // remove legacy tag mode selector (if included)
  delete request.query.where._tagged;

  const query = await models.Recording.makeBaseQuery(
    request.user,
    request.query.where,
    request.query.tagMode,
    request.query.tags,
    request.query.offset,
    request.query.limit,
    request.query.order
  );

  const result = await models.Recording.findAndCountAll(query);

  const filterOptions = models.Recording.makeFilterOptions(
    request.user,
    request.filterOptions
  );
  // XXX don't loop over twice
  result.rows.map(rec => rec.filterData(filterOptions));
  result.rows = result.rows.map(handleLegacyTagFieldsForGetOnRecording);
  return result;
}

// Returns a promise for report rows for a set of recordings. Takes
// the same parameters as query() above.
async function report(request) {
  if (!request.query.where) {
    request.query.where = {};
  }

  const query = await models.Recording.makeBaseQuery(
    request.user,
    request.query.where,
    request.query.tagMode,
    request.query.tags,
    request.query.offset,
    request.query.limit,
    request.query.order
  );
  query.attributes.push("comment"); // XXX add this to builder too

  // XXX dodgy - replace with a builder
  // XXX consider moving all this to a specialised method on build to get the DB logic out of here
  const deviceInclude = query.include[3];
  deviceInclude.include = [
    {
      model: models.Event,
      required: false,
      where: {
        dateTime: {
          [Op.lt]: sequelize.literal('"Recording"."recordingDateTime"'),
          [Op.gt]: sequelize.literal(
            '"Recording"."recordingDateTime" - interval \'30 minutes\''
          )
        }
      },
      include: [
        {
          model: models.DetailSnapshot,
          as: "EventDetail",
          required: true,
          where: {
            type: "audioBait"
          },
          attributes: ["details"]
        }
      ]
    }
  ];
  const result = await models.Recording.findAll(query);

  const filterOptions = models.Recording.makeFilterOptions(
    request.user,
    request.filterOptions
  );

  const recording_url_base = config.server.recording_url_base || "";

  const out = [
    [
      "id",
      "type",
      "group",
      "device",
      "timestamp",
      "duration",
      "comment",
      "track_count",
      "automatic_track_tags",
      "human_track_tags",
      "recording_tags",
      "last_audio_bait",
      "last_audio_bait_time",
      "mins_since_last_audio_bait",
      "url"
    ]
  ];

  for (let r of result) {
    r.filterData(filterOptions);

    automatic_track_tags = new Set();
    human_track_tags = new Set();
    for (let track of r.Tracks) {
      for (let tag of track.TrackTags) {
        const subject = tag.what || tag.detail;
        if (tag.automatic) {
          automatic_track_tags.add(subject);
        } else {
          human_track_tags.add(subject);
        }
      }
    }

    const recording_tags = r.Tags.map(t => t.what || t.detail);

    let audioBaitName = "";
    let audioBaitTime = null;
    let audioBaitDelta = null;
    const latestAudioEvent = findLatestEvent(r.Device.Events);
    if (latestAudioEvent) {
      audioBaitName = await getAudioEventName(latestAudioEvent);
      audioBaitTime = moment(latestAudioEvent.dateTime);
      audioBaitDelta = moment
        .duration(r.recordingDateTime - audioBaitTime)
        .asMinutes()
        .toFixed(1);
    }

    out.push([
      r.id,
      r.type,
      r.Group.groupname,
      r.Device.devicename,
      moment(r.recordingDateTime).format(),
      r.duration,
      r.comment,
      r.Tracks.length,
      formatTags(automatic_track_tags),
      formatTags(human_track_tags),
      formatTags(recording_tags),
      audioBaitName,
      audioBaitTime ? audioBaitTime.format() : "",
      audioBaitDelta,
      urljoin(recording_url_base, r.id.toString())
    ]);
  }
  return out;
}

function findLatestEvent(events) {
  if (!events) {
    return null;
  }

  let latest = events[0];
  for (let event of events) {
    if (event.dateTime > latest.dateTime) {
      latest = event;
    }
  }
  return latest;
}

async function getAudioEventName(event) {
  const fileInfo = await event.EventDetail.getFile();
  if (!fileInfo) {
    return null;
  }
  return fileInfo.details.name;
}

function formatTags(tags) {
  const out = Array.from(tags);
  out.sort();
  return out.join("+");
}

async function get(request, type) {
  const recording = await models.Recording.get(
    request.user,
    request.params.id,
    models.Recording.Perms.VIEW,
    {
      type: type,
      filterOptions: request.query.filterOptions
    }
  );
  if (!recording) {
    throw new ClientError("No file found with given datapoint.");
  }

  const downloadFileData = {
    _type: "fileDownload",
    key: recording.fileKey,
    filename: recording.getFileName(),
    mimeType: recording.fileMimeType
  };

  const downloadRawData = {
    _type: "fileDownload",
    key: recording.rawFileKey,
    filename: recording.getRawFileName(),
    mimeType: recording.rawMimeType
  };
  delete recording.rawFileKey;

  return {
    recording: handleLegacyTagFieldsForGetOnRecording(recording),
    cookedJWT: jsonwebtoken.sign(
      downloadFileData,
      config.server.passportSecret,
      { expiresIn: 60 * 10 }
    ),
    rawJWT: jsonwebtoken.sign(downloadRawData, config.server.passportSecret, {
      expiresIn: 60 * 10
    })
  };
}

async function delete_(request, response) {
  const deleted = await models.Recording.deleteOne(
    request.user,
    request.params.id
  );
  if (deleted) {
    responseUtil.send(response, {
      statusCode: 200,
      messages: ["Deleted recording."]
    });
  } else {
    responseUtil.send(response, {
      statusCode: 400,
      messages: ["Failed to delete recording."]
    });
  }
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
    models.Recording.Perms.UPDATE
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
async function reprocess(request, response) {
  const responseInfo = await reprocessRecording(
    request.user,
    request.params.id
  );
  responseUtil.send(response, responseInfo);
}

exports.makeUploadHandler = makeUploadHandler;
exports.query = query;
exports.report = report;
exports.get = get;
exports.delete_ = delete_;
exports.addTag = addTag;
exports.reprocess = reprocess;
exports.reprocessAll = reprocessAll;

var util = require('./util');
var orm = require('./orm');
var log = require('../logging');

module.exports = function(data) {
  log.verbose('New Location Object');

  this.name = 'location';
  this.ormClass = orm.location;

  this.modelMap = {
    id: {},
    timestamp: {},
    latitude: {},
    longitude: {},
    altitude: {},
    accuracy: {},
    userLocationInput: {},
    tags: {},
    extra: {}
  }

  this.ormBuild = null;
  this.modelData = {};
  this.childModels = [];

  util.parseModel(this, data);
}
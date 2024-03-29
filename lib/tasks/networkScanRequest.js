/**
 * Performs a networkScanRequest
 * Created by kc on 23.06.15.
 */

const rapidConnector       = require('../rapidConnector');
const logger               = require('../logger').getLogger('core:tasks:networkScanRequest');
const ErrorFrame           = require('../messages/errorFrame').ErrorFrame;
const _                    = require('lodash');
const util                 = require('util');
const DIAGNOSTICS_HEADER   = 0xd1;
const NETWORK_SCAN_REQUEST = 0x00;

let lastLqi  = 250;
let lastRssi = -50;
let settings = {};

/**
 * Helper: handle duplicate networks found. We use the higher value:
 * if there are a coordinator and several routers in range, we are only interested
 * of the value of the closest device
 *
 * @param networks is the array with the networks found
 */
function handleDuplicates(networks) {
  let retVal = [];

  for (let i = 0; i < networks.length; i++) {
    let n = _.find(retVal, {extendedPanId: networks[i].extendedPanId});
    if (n) {
      logger.debug('Duplicate network found ' + networks[i].extendedPanId);
      // Already in list: use the higher values
      if (n.rssi < networks[i].rssi) {
        n.rssi = networks[i].rssi;
        n.lqi  = networks[i].lqi;
      }
    } else {
      // Not already in list, push it
      retVal.push(networks[i]);
    }
  }

  return retVal;
}


/**
 * Constructor
 * @param options
 * @constructor
 */
function NetworkScanRequest(options) {
  this.options       = options;
  this.foundNetworks = [];
}

/**
 * The real handler with RapidConnect
 * @param callback
 */
NetworkScanRequest.prototype.rapidConnectHandling = function (callback) {

  this.foundNetworks = [];

  let self = this;

  if (!rapidConnector.isConnected()) {
    logger.info('not connected, scanning not possible');
    return callback(new Error('not connected'));
  }

  /**
   * The last thing done - the only place where the callback is called
   * @param err
   * @param networks
   */
  function finishTask(err, networks) {
    rapidConnector.removeListener('d1-1', onNetworkScanResponse);
    rapidConnector.removeListener('d1-2', onNetworkScanComplete);
    rapidConnector.removeListener('close', onRapidConnectorClose);
    rapidConnector.removeListener('55-e0', onError);
    rapidConnector.removeListener('55-80', onStatusResponse);
    callback(err, networks);
  }

  /**
   * Handler for the network scan responses for NETWORK_SCAN_RESPONSE
   * @param data
   */
  function onNetworkScanResponse(data) {
    //logger.debug('D101 NETWORK_SCAN_RESPONSE');
    try {
      let network           = {};
      network.channel       = data[0];
      network.panId         = (data[1] + data[2] * 256).toString(16).toUpperCase();
      network.extendedPanId = '';
      for (let i = 10, t = 0; i > 2; i--, t++) {
        if (data[i] < 17) {
          network.extendedPanId += '0';
        }
        network.extendedPanId += data[i].toString(16).toUpperCase();
        if (t % 2) {
          network.extendedPanId += ' ';
        }
      }
      network.extendedPanId = _.trim(network.extendedPanId);

      // Set device label for custom specified devices
      if (settings.custom && settings.custom.devices) {
        for (i = 0; i < settings.custom.devices.length; i++) {
          if (_.startsWith(network.extendedPanId, settings.custom.devices[i].macAddress)) {
            network.device = settings.custom.devices[i].label;
          }
        }
      }

      network.permitJoin   = (data[11] === 0x01) ? 'yes' : 'no';
      network.stackProfile = data[12];
      network.lqi          = data[13];
      network.found        = true;
      if (data[14] < 128) {
        network.rssi = data[14];
      } else {
        network.rssi = data[14] - 256;
      }
      logger.debug('NETWORK_SCAN_RESPONSE Result: ' + network.panId + ' ' + network.rssi);
      self.foundNetworks.push(network);
    }
    catch (e) {
      logger.debug('Exception in onNetworkScanResponse');
      logger.error(util.inspect(e));
      finishTask(e);
    }
  }

  // What happens when the USB dongle is disconnected during the scan
  function onRapidConnectorClose() {
    finishTask(new Error('disconnected'));
  }

  // What happens when the scan is finished: NETWORK_SCAN_COMPLETE received
  function onNetworkScanComplete(data) {
    try {
      if (data[0] === 0x01) {
        // Todo: not sure about this, looks like a busy is followed by an ok, avoid double callback calls
        logger.info('D102 NETWORK_SCAN_COMPLETE - Busy');
        _.delay(finishTask, 5000);
        return;
      }

      // finished the scan, return the found network(s)
      logger.debug('D102 NETWORK_SCAN_COMPLETE - Finished');
      // Clean up the found networks, find duplicates
      self.foundNetworks = handleDuplicates(self.foundNetworks);

      if (self.options.panId) {
        // Filter: return only the networks with correct panId this one is supplied
        self.foundNetworks = _.filter(self.foundNetworks, function (n) {
          return (n.panId === self.options.panId);
        });

        if (self.foundNetworks.length === 0) {
          // But return at least one with minimal data
          logger.info('Network not found, adding empty data');
          self.foundNetworks.push({
            permitJoin   : 'no',
            stackProfile : 0,
            panId        : self.options.panId || '0000',
            channel      : self.options.channel || 0,
            extendedPanId: '0000 0000 0000 0000',
            rssi         : _.get(settings, 'levels.min', -100),
            lqi          : 0,
            found        : false
          });
        }
      }
      finishTask(null, self.foundNetworks);
    }
    catch (e) {
      logger.debug('Exception in onNetworkScanComplete, try to recover');
      logger.error(util.inspect(e));
      finishTask(e);
    }
  }

  /**
   * Something went terribly wrong, an ERROR message was received
   * @param data
   */
  function onError(data) {
    let errorFrame = new ErrorFrame(data);
    finishTask(errorFrame.getError());
  }

  function onStatusResponse(data) {
    logger.info('STATUS_RESPONSE', data);
  }

  // Register on Events: close
  rapidConnector.on('close', onRapidConnectorClose);

  // NETWORK_SCAN_RESPONSE
  rapidConnector.on('d1-1', onNetworkScanResponse);

  // NETWORK_SCAN_COMPLETE
  rapidConnector.once('d1-2', onNetworkScanComplete);

  // STATUS_RESPONSE
  rapidConnector.on('55-80', onStatusResponse);

  // ERROR
  rapidConnector.on('55-e0', onError);


// Create the payload of the frame out of the options (and some defaults)
  let scanDuration = self.options.scanDuration || 0x03;
  let channels     = self.options.channels || [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26];
  let channelMask  = 0;
  for (let i = 0; i < channels.length; i++) {
    channelMask |= (1 << channels[i]);
  }
  let payload = [];
  payload.push(channelMask & 0xff);
  payload.push((channelMask & 0xff00) >> 8);
  payload.push((channelMask & 0xff0000) >> 16);
  payload.push((channelMask & 0xff000000) >> 24);
  payload.push(scanDuration);

// LSB First for UINT32 values
// rapidConnector.writeFrame(DIAGNOSTICS_HEADER, NETWORK_SCAN_REQUEST, [0x00, 0xf8, 0xff, 0x07, scanDuration], dataHandler);
  rapidConnector.writeFrame(DIAGNOSTICS_HEADER, NETWORK_SCAN_REQUEST, payload);
  /*
   Resulting frames
   __________0  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17 18 19 20
   <Buffer fe d1 01 0f 19 a5 39 36 01 00 2c 00 bc 15 00 00 02 ff d4 e1 04>  RSSI in range -44
   <Buffer fe d1 01 0f 19 df d0 27 01 00 2c 00 bc 15 00 00 02 79 bc 05 05>  RSSI in range -70
   ___________::::: ----------------------------------- xx ** -- --
   ___________PANID Extended PAN ID                     PJ SP LQ RSSI
   ____________D0DF  0015...0127

   <Buffer fe d1 01 0f 19 df d0 27 01 00 2c 00 bc 15 00 00 02 e4 be 72 05>
   <Buffer fe d1 01 0f 19 a5 39 36 01 00 2c 00 bc 15 00 00 02 ff d6 e3 04>

   <Buffer fe d1 01 0f 19 df d0 27 01 00 2c 00 bc 15 00 00 02 e6 be 74 05>
   <Buffer fe d1 01 0f 19 a5 39 36 01 00 2c 00 bc 15 00 00 02 ff d4 e1 04>

   <Buffer fe d1 01 0f 19 a5 39 36 01 00 2c 00 bc 15 00 00 02 ff d0 dd 04>
   <Buffer fe d1 01 0f 19 df d0 27 01 00 2c 00 bc 15 00 00 02 bf bb 4a 05>

   <Buffer fe d1 01 0f 19 a5 39 36 01 00 2c 00 bc 15 00 00 02 ff ce db 04>
   <Buffer fe d1 01 0f 19 df d0 27 01 00 2c 00 bc 15 00 00 02 e9 bd 76 05>

   <Buffer fe d1 01 0f 19 a5 39 36 01 00 2c 00 bc 15 00 00 02 ff cf dc 04>
   <Buffer fe d1 01 0f 19 df d0 27 01 00 2c 00 bc 15 00 00 02 dd bc 69 05>

   unsigned char:
   x00 .. x7f: 0 - 127
   x7f .. xff: -128 - -1
   128    255
   */
};

/**
 * Simulation handling with dummy data
 * @param callback
 */
NetworkScanRequest.prototype.simulator = function (callback) {
  function generateRandomNetworkEntry() {

    return ({
      channel      : _.random(11, 26),
      panId        : _.random(1, 65500).toString(16),
      extendedPanId: 'dummy',
      permitJoin   : (_.random(0, 1) === 1),
      stackProfile : 2,
      lqi          : _.random(180, 255),
      rssi         : _.random(-80, -40),
      found        : true
    });
  }

  let result = [];

  if (this.options.panId) {
    // Only one network shall be scanned
    let newLqi = lastLqi + _.random(-1, 1);
    if (newLqi > 255 || newLqi < 1) {
      newLqi = lastLqi;
    }
    lastLqi = newLqi;

    let newRssi = lastRssi + _.random(-4, 4);
    if (newRssi > -3 || newRssi < -80) {
      newRssi = lastRssi;
    }
    lastRssi = newRssi;

    result.push({
      channel   : this.options.channelId,
      panId     : this.options.panId,
      lqi       : newLqi,
      rssi      : newRssi,
      permitJoin: (_.random(0, 5) === 0)
    });
    _.delay(callback, _.random(30, 400), null, result);
  } else {
    // All networks
    let networkNb = _.random(0, 8);

    for (let i = 0; i < networkNb; i++) {
      result.push(generateRandomNetworkEntry());
    }
    result = _.sortByOrder(result, ['channel', 'panId'], [true, true]);
    // Delay it as it would be in the real world
    _.delay(callback, _.random(2, 4), null, result);
  }
};


module.exports = {
  setSettings: function (_settings) {
    settings = _.assign(settings, _settings);
  },
  start      : function (options, callback) {
    logger.debug('STARTING NEW SCAN');
    let req = new NetworkScanRequest(options);
    if (settings.simulator) {
      req.simulator(callback);
    } else {
      req.rapidConnectHandling(callback);
    }
  }
};

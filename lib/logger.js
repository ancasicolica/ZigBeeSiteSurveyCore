/**
 * ZigBee Logger
 * Created by kc on 26.11.15.
 */

const winston = require('winston');
const moment  = require('moment');
const util    = require('util');
const _       = require('lodash');

let settings = {
  level   : process.env.LOG_LEVEL || 'info',
  colorize: true
};

const loggerSettings = {
  levels: {
    fatal: 4,
    error: 3,
    info : 2,
    warn : 1,
    debug: 0
  },
  colors: {
    fatal: 'blue',
    error: 'red',
    info : 'green',
    warn : 'yellow',
    debug: 'grey'
  }
};

const logger = winston.createLogger({
  level: loggerSettings.levels, transports: [
    new winston.transports.Console({
      level : 'info',
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    }),
  ],
});
winston.addColors(loggerSettings.colors);

/**
 * Core logging function
 * @param module
 * @param level
 * @param message
 * @param metadata
 */
const log = function (module, level, message, metadata) {
  let info = moment().format() + ' ' + module + ': ';
  if (_.isObject(message)) {
    info += util.inspect(message);
  }
  else {
    info += message;
  }
  if (metadata) {
    if (_.isObject(metadata)) {
      info += '\n' + util.inspect(metadata);
    }
    else {
      info += ' ' + metadata;
    }
  }
  logger.log(level, info);
};

module.exports = {
  setSettings: function (_settings) {
    settings = _.assign(settings, _settings);
  },

  add: function (transport, options) {
    logger.add(transport, options);
  },

  remove: function (transport) {
    logger.remove(transport);
  },

  getLogger: function (moduleName) {
    return {
      fatal: function (message, metadata) {
        log(moduleName, 'fatal', message, metadata);
      },
      error: function (message, metadata) {
        log(moduleName, 'error', message, metadata);
      },
      info : function (message, metadata) {
        log(moduleName, 'info', message, metadata);
      },
      warn : function (message, metadata) {
        log(moduleName, 'warn', message, metadata);
      },
      debug: function (message, metadata) {
        if (settings.level === 'debug') {
          log(moduleName, 'info', message, metadata); // using info as otherwise on stderr
        }
      }
    };
  }
};

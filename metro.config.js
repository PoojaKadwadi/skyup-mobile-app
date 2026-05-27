const {getDefaultConfig, mergeConfig} = require('@react-native/metro-config');

const config = {
  resolver: {
    blockList: [/android[\\\/]build[\\\/].*/],
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);

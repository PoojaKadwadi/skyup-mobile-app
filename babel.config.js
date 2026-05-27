module.exports = {
  presets: ['module:@react-native/babel-preset'],
  plugins: [
    // react-native-dotenv: reads .env and exposes as @env
    ['module:react-native-dotenv', {
      moduleName: '@env',
      path: '.env',
      safe: false,
      allowUndefined: true,
    }],
    // react-native-reanimated must be last
    'react-native-reanimated/plugin',
  ],
};

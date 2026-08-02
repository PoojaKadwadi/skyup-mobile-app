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
  env: {
    // PERF: strip every console.log/warn/info/debug call from release builds
    // only (dev/Metro logging is untouched). This app runs a long-lived
    // Android foreground service (auto-upload) that keeps the JS process
    // alive for days at a stretch, and several services log on every
    // interval tick (socket events, background sync, follow-up checks,
    // notification scheduling) — over 140 console calls in src/ today. Each
    // call has a real (if small) formatting/bridge cost that compounds over
    // a multi-day uptime session. console.error is kept so release crashes
    // still surface in crash reporting / adb logcat.
    production: {
      plugins: [
        ['transform-remove-console', { exclude: ['error'] }],
      ],
    },
  },
};
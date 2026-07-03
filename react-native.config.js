// react-native.config.js
//
// Disables Android autolinking for react-native-encrypted-storage.
// Its native module builds EncryptedSharedPreferences in its CONSTRUCTOR,
// which reads an AES keyset from the Android Keystore. On some devices the
// keystore entry is unreadable/corrupted (StrongBox unavailable / keyset
// not found), the constructor throws during createReactContext(), and the
// entire RN bridge fails -> app "keeps stopping" on every launch.
// This module is not used anywhere in the app's JS, so disabling autolink
// removes the crash with zero functional loss.

module.exports = {
  dependencies: {
    'react-native-encrypted-storage': {
      platforms: {
        android: null,
      },
    },
  },
};
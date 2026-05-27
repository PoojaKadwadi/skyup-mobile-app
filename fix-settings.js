const path = require('path');
const fs = require('fs');

const pluginPath = path.resolve('node_modules/@react-native/gradle-plugin').replace(/\\/g, '/');

const content = `pluginManagement {
    includeBuild('${pluginPath}')
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

plugins { id('com.facebook.react.settings') }

extensions.configure(com.facebook.react.ReactSettingsExtension) { ex ->
    ex.autolinkLibrariesFromCommand()
}

rootProject.name = 'SkyUpCRM'
include ':app'
`;

fs.writeFileSync('android/settings.gradle', content);
console.log('Written:', pluginPath);
console.log('\nVerifying file contents:');
console.log(fs.readFileSync('android/settings.gradle', 'utf8'));
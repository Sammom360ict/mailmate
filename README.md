# MailMate

Backend-free Android Gmail OTP helper built with React Native.

## Features

- Connect multiple Gmail accounts with Google App Passwords over IMAP.
- Select individual or all connected accounts.
- Find 4–8 digit OTP codes in recent inbox messages and copy them.
- Keep New/Used status on the device; copying a code marks it Used.
- Create and copy Gmail `+tag` aliases.
- Show a draggable floating OTP window over other apps.
- Keep account credentials in Android Keystore-backed encrypted storage.

Temp Mail is currently out of scope. Gmail messages are read directly from Gmail; there is no MailMate server.

## Gmail setup

Turn on 2-Step Verification for the Google account and create a 16-character App Password. Add the Gmail address and App Password in the app. Google Workspace accounts may have App Password access disabled by their administrator.

## Build Android

Install Node.js 22.11 or newer, JDK 17 or newer, Android SDK Platform 37, and Android Build Tools 37. Then run:

```sh
npm install
npx react-native run-android
```

To build a debug APK:

```sh
cd android
./gradlew assembleDebug
```

The APK is written to `android/app/build/outputs/apk/debug/app-debug.apk`.

For a signed release APK, put a release keystore and a private `android/release-signing.properties` file in place, then run `./gradlew assembleRelease`. Keep both signing files safe: future APK updates must use the same signing key.

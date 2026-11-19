package com.mailmate;

import android.content.Intent;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.modules.core.DeviceEventManagerModule;
import java.util.Properties;
import java.util.Date;
import org.json.JSONObject;
import javax.mail.UIDFolder;
import javax.mail.Message;
import javax.mail.Session;
import javax.mail.Store;

public class MailMateNativeModule extends ReactContextBaseJavaModule {
  private static volatile MailMateNativeModule instance;
  public MailMateNativeModule(ReactApplicationContext context) { super(context); instance = this; }
  @Override public String getName() { return "MailMateNative"; }
  @ReactMethod public void addListener(String eventName) {}
  @ReactMethod public void removeListeners(double count) {}
  private final Handler main = new Handler(Looper.getMainLooper());

  static void emitChange(String event) {
    MailMateNativeModule module = instance;
    if (module == null) return;
    ReactApplicationContext context = module.getReactApplicationContext();
    if (context.hasActiveReactInstance()) {
      context.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class).emit(event, null);
    }
  }

  @ReactMethod public void verifyGmail(String email, String password, Promise promise) {
    new Thread(() -> {
      Store store = null;
      try {
        store = connect(email, password);
        promise.resolve(true);
      } catch (Exception e) { promise.reject("GMAIL_AUTH", friendly(e)); }
      finally { if (store != null) try { store.close(); } catch (Exception ignored) {} }
    }).start();
  }

  static Store connect(String email, String password) throws Exception {
    Properties props = new Properties();
    props.put("mail.imaps.host", "imap.gmail.com"); props.put("mail.imaps.port", "993");
    props.put("mail.imaps.ssl.enable", "true");
    props.put("mail.imaps.ssl.checkserveridentity", "true");
    props.put("mail.imaps.peek", "true");
    props.put("mail.imaps.throwsearchexception", "true"); props.put("mail.imaps.connectiontimeout", "12000");
    props.put("mail.imaps.timeout", "12000"); props.put("mail.imaps.writetimeout", "12000");
    Session session = Session.getInstance(props);
    Store store = session.getStore("imaps"); store.connect("imap.gmail.com", email, password); return store;
  }
  static JSONObject toOtpItem(String email, Message message, String code) throws Exception {
    String subject = message.getSubject();
    if (subject == null) subject = "";
    String sender = message.getFrom() == null || message.getFrom().length == 0 ? email : message.getFrom()[0].toString();
    Date received = message.getReceivedDate() == null ? new Date() : message.getReceivedDate();
    long stableId = message.getMessageNumber();
    try {
      if (message.getFolder() instanceof UIDFolder) stableId = ((UIDFolder) message.getFolder()).getUID(message);
    } catch (Exception ignored) {}
    String id = email + ":" + stableId + ":" + received.getTime();
    JSONObject item = new JSONObject();
    item.put("id", id); item.put("email", email); item.put("sender", sender);
    item.put("subject", subject.isEmpty() ? "Verification code" : subject);
    item.put("code", code); item.put("date", received.toString());
    item.put("receivedAt", received.getTime());
    item.put("used", false);
    return item;
  }
  private String friendly(Exception e) {
    String message = e.getMessage() == null ? "" : e.getMessage().toLowerCase();
    if (message.contains("authenticationfailed") || message.contains("invalid credentials") || message.contains("username and password")) return "Gmail sign-in failed. Check the 16-character App Password and 2-Step Verification.";
    return "Could not connect to Gmail. Check your internet connection, App Password, and account IMAP access.";
  }

  @ReactMethod public void canDrawOverlays(Promise promise) { promise.resolve(Settings.canDrawOverlays(getReactApplicationContext())); }
  @ReactMethod public void requestOverlayPermission(Promise promise) {
    Intent intent = new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:" + getReactApplicationContext().getPackageName()));
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); getReactApplicationContext().startActivity(intent); promise.resolve(true);
  }
  @ReactMethod public void configureMonitoring(String accountsJson, Promise promise) {
    ReactApplicationContext context = getReactApplicationContext();
    try {
      Intent intent = new Intent(context, FloatingService.class);
      if ("[]".equals(accountsJson)) {
        context.stopService(intent);
      } else {
        intent.setAction(FloatingService.ACTION_CONFIGURE).putExtra("accounts", accountsJson);
        if (android.os.Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent);
        else context.startService(intent);
      }
      promise.resolve(true);
    } catch (RuntimeException error) {
      promise.reject("MONITOR_START", "Open Mail Mate to start Gmail sync.", error);
    }
  }

  @ReactMethod public void setOverlayVisible(boolean visible, Promise promise) {
    main.post(() -> promise.resolve(FloatingService.setOverlay(visible)));
  }

  @ReactMethod public void getMonitorStatus(Promise promise) {
    main.post(() -> promise.resolve(FloatingService.monitorStatus()));
  }

  @ReactMethod public void requestSync(Promise promise) {
    main.post(() -> FloatingService.refresh().whenComplete((result, failure) -> {
      if (failure == null) {
        promise.resolve(OtpJournal.read(getReactApplicationContext()).toString());
      } else {
        Throwable cause = failure.getCause() == null ? failure : failure.getCause();
        String message = cause instanceof IllegalStateException ? cause.getMessage() : "Could not finish checking all selected inboxes. Check the connection and try again.";
        promise.reject("GMAIL_SYNC", message);
      }
    }));
  }

  @ReactMethod public void getOtpJournal(Promise promise) {
    promise.resolve(OtpJournal.read(getReactApplicationContext()).toString());
  }

  @ReactMethod public void markOtpUsed(String id, Promise promise) {
    OtpJournal.markUsed(getReactApplicationContext(), id);
    main.post(() -> FloatingService.markOverlayUsed(id));
    promise.resolve(true);
  }

  @ReactMethod public void clearAccountOtps(String email, Promise promise) {
    OtpJournal.removeAccount(getReactApplicationContext(), email);
    promise.resolve(true);
  }
}

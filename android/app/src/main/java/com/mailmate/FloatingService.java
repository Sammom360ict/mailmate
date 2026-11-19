package com.mailmate;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.provider.Settings;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.WindowManager;
import android.widget.LinearLayout;
import android.widget.TextView;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.Iterator;
import java.util.Map;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
import javax.mail.Flags;
import javax.mail.Message;
import javax.mail.MessageRemovedException;
import javax.mail.MessagingException;
import javax.mail.Store;
import org.json.JSONArray;
import org.json.JSONObject;

public class FloatingService extends Service {
  static final String ACTION_CONFIGURE = "com.mailmate.CONFIGURE";
  private static final String CHANNEL = "mailmate_mail_sync";
  private static FloatingService active;
  private final Handler main = new Handler(Looper.getMainLooper());
  private final Map<String, AccountMonitor> monitors = new HashMap<>();
  private WindowManager manager;
  private LinearLayout window;
  private WindowManager.LayoutParams position;
  private TextView accountView, codeView, copyView;
  private JSONObject latest;

  @Override public void onCreate() {
    super.onCreate();
    active = this;
    manager = getSystemService(WindowManager.class);
    if (Build.VERSION.SDK_INT >= 26) {
      getSystemService(NotificationManager.class).createNotificationChannel(
        new NotificationChannel(CHANNEL, "Gmail sync", NotificationManager.IMPORTANCE_LOW));
    }
  }

  @Override public int onStartCommand(Intent intent, int flags, int startId) {
    startForeground(41, notification());
    if (intent == null || !ACTION_CONFIGURE.equals(intent.getAction())) {
      stopSelf();
      return START_NOT_STICKY;
    }
    String credentials = intent.getStringExtra("accounts");
    intent.removeExtra("accounts");
    configure(credentials);
    return START_NOT_STICKY;
  }

  private Notification notification() {
    Notification.Builder builder = Build.VERSION.SDK_INT >= 26
      ? new Notification.Builder(this, CHANNEL) : new Notification.Builder(this);
    PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class),
      PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    return builder.setSmallIcon(android.R.drawable.ic_dialog_email)
      .setContentTitle("Mail Mate · Gmail sync")
      .setContentText("Checking selected inboxes for unread mail")
      .setContentIntent(open).setOngoing(true).build();
  }

  private void configure(String credentials) {
    Map<String, String> requested = new HashMap<>();
    try {
      JSONArray items = new JSONArray(credentials);
      for (int i = 0; i < items.length(); i++) {
        JSONObject item = items.getJSONObject(i);
        requested.put(item.getString("email"), item.getString("password"));
      }
    } catch (Exception ignored) {
      return;
    }
    Iterator<AccountMonitor> existing = monitors.values().iterator();
    while (existing.hasNext()) {
      AccountMonitor worker = existing.next();
      if (!worker.password.equals(requested.get(worker.email))) {
        worker.stopMonitoring();
        existing.remove();
      }
    }
    if (latest != null && !requested.containsKey(latest.optString("email"))) latest = null;
    for (Map.Entry<String, String> entry : requested.entrySet()) {
      if (monitors.containsKey(entry.getKey())) continue;
      AccountMonitor worker = new AccountMonitor(entry.getKey(), entry.getValue());
      monitors.put(entry.getKey(), worker);
      worker.start();
    }
    selectLatestSaved();
    if (monitors.isEmpty()) stopSelf();
    renderOverlay();
    MailMateNativeModule.emitChange("syncStatusChanged");
  }

  static String monitorStatus() {
    if (active == null || active.monitors.isEmpty()) return "Sync paused";
    int ready = 0;
    boolean retrying = false;
    for (AccountMonitor worker : active.monitors.values()) {
      if (worker.state == SyncState.READY) ready++;
      if (worker.state == SyncState.RETRYING) retrying = true;
    }
    if (ready == active.monitors.size()) return "Sync active";
    if (ready > 0) return "Some accounts offline";
    return retrying ? "Reconnecting…" : "Starting sync…";
  }

  static CompletableFuture<Void> refresh() {
    if (active == null || active.monitors.isEmpty()) {
      CompletableFuture<Void> result = new CompletableFuture<>();
      result.completeExceptionally(new IllegalStateException("Gmail sync is starting."));
      return result;
    }
    List<CompletableFuture<Void>> checks = new ArrayList<>();
    for (AccountMonitor worker : active.monitors.values()) checks.add(worker.requestCheck());
    return CompletableFuture.allOf(checks.toArray(new CompletableFuture<?>[0]));
  }

  static boolean setOverlay(boolean visible) {
    if (active == null) return !visible;
    if (visible) active.showOverlay();
    else active.hideOverlay();
    return !visible || active.window != null;
  }

  private int dp(float value) {
    return Math.round(value * getResources().getDisplayMetrics().density);
  }

  private GradientDrawable background(int color, int radius, int stroke) {
    GradientDrawable shape = new GradientDrawable();
    shape.setColor(color);
    shape.setCornerRadius(dp(radius));
    if (stroke != 0) shape.setStroke(dp(1), stroke);
    return shape;
  }

  private TextView label(String text, int size, int color) {
    TextView view = new TextView(this);
    view.setText(text);
    view.setTextSize(size);
    view.setTextColor(color);
    view.setGravity(Gravity.CENTER_VERTICAL);
    return view;
  }

  private void showOverlay() {
    if (window != null || !Settings.canDrawOverlays(this)) return;
    LinearLayout root = new LinearLayout(this);
    root.setGravity(Gravity.CENTER_VERTICAL);
    root.setPadding(dp(12), dp(8), dp(6), dp(8));
    root.setBackground(background(0xff102923, 22, 0xff42665c));
    root.setElevation(dp(6));

    TextView grip = label("⠿", 20, 0xff94bead);
    grip.setContentDescription("Drag floating window");
    root.addView(grip, new LinearLayout.LayoutParams(dp(24), dp(44)));

    LinearLayout details = new LinearLayout(this);
    details.setOrientation(LinearLayout.VERTICAL);
    accountView = label("Mail Mate", 11, 0xffa6c8bb);
    accountView.setSingleLine();
    accountView.setEllipsize(TextUtils.TruncateAt.END);
    codeView = label("Waiting for OTP", 18, Color.WHITE);
    codeView.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
    codeView.setSingleLine();
    codeView.setEllipsize(TextUtils.TruncateAt.END);
    details.addView(accountView);
    details.addView(codeView);
    root.addView(details, new LinearLayout.LayoutParams(dp(138), -2));

    copyView = label("Copy", 12, 0xff102923);
    copyView.setGravity(Gravity.CENTER);
    copyView.setTypeface(null, Typeface.BOLD);
    copyView.setBackground(background(0xffb9f1d8, 12, 0));
    root.addView(copyView, new LinearLayout.LayoutParams(dp(54), dp(44)));
    copyView.setOnClickListener(view -> copyCode());

    TextView close = label("×", 23, 0xffc6ded5);
    close.setGravity(Gravity.CENTER);
    close.setContentDescription("Hide floating window");
    root.addView(close, new LinearLayout.LayoutParams(dp(44), dp(44)));
    close.setOnClickListener(view -> {
      hideOverlay();
      MailMateNativeModule.emitChange("overlayClosed");
    });

    if (position == null) {
      int type = Build.VERSION.SDK_INT >= 26 ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        : WindowManager.LayoutParams.TYPE_PHONE;
      position = new WindowManager.LayoutParams(-2, -2, type, WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
        PixelFormat.TRANSLUCENT);
      position.gravity = Gravity.TOP | Gravity.LEFT;
      position.x = dp(12);
      position.y = dp(100);
    }
    View.OnTouchListener drag = new View.OnTouchListener() {
      private int startX, startY;
      private float downX, downY;
      private boolean moving;

      @Override public boolean onTouch(View view, MotionEvent event) {
        switch (event.getActionMasked()) {
          case MotionEvent.ACTION_DOWN:
            startX = position.x;
            startY = position.y;
            downX = event.getRawX();
            downY = event.getRawY();
            moving = false;
            return true;
          case MotionEvent.ACTION_MOVE:
            int dx = Math.round(event.getRawX() - downX);
            int dy = Math.round(event.getRawY() - downY);
            int slop = ViewConfiguration.get(FloatingService.this).getScaledTouchSlop();
            moving |= Math.abs(dx) > slop || Math.abs(dy) > slop;
            if (moving && window != null) {
              android.graphics.Point size = new android.graphics.Point();
              manager.getDefaultDisplay().getSize(size);
              position.x = Math.max(0, Math.min(startX + dx, size.x - window.getWidth()));
              position.y = Math.max(0, Math.min(startY + dy, size.y - window.getHeight()));
              manager.updateViewLayout(window, position);
            }
            return true;
          case MotionEvent.ACTION_UP:
          case MotionEvent.ACTION_CANCEL:
            return true;
          default:
            return false;
        }
      }
    };
    root.setOnTouchListener(drag);
    grip.setOnTouchListener(drag);
    details.setOnTouchListener(drag);
    try {
      manager.addView(root, position);
      window = root;
      selectLatestSaved();
      renderOverlay();
    } catch (RuntimeException ignored) {}
  }

  private void selectLatestSaved() {
    latest = null;
    JSONArray saved = OtpJournal.read(this);
    for (int i = 0; i < saved.length(); i++) {
      JSONObject item = saved.optJSONObject(i);
      if (item != null && monitors.containsKey(item.optString("email")) &&
          (latest == null || item.optLong("receivedAt") > latest.optLong("receivedAt"))) {
        latest = item;
      }
    }
  }

  private void renderOverlay() {
    if (window == null) return;
    boolean hasCode = latest != null;
    boolean used = hasCode && latest.optBoolean("used");
    accountView.setText(hasCode ? latest.optString("email") : "MAIL MATE");
    codeView.setText(hasCode ? latest.optString("code") : "Waiting…");
    codeView.setTextColor(!hasCode ? Color.WHITE : used ? 0xffffa69f : 0xff9ff3cd);
    copyView.setEnabled(hasCode);
    copyView.setAlpha(hasCode ? 1f : .45f);
  }

  private void hideOverlay() {
    if (window == null) return;
    try { manager.removeView(window); } catch (IllegalArgumentException ignored) {}
    window = null;
  }

  private void copyCode() {
    if (latest == null) return;
    getSystemService(ClipboardManager.class).setPrimaryClip(ClipData.newPlainText("OTP", latest.optString("code")));
    OtpJournal.markUsed(this, latest.optString("id"));
    renderUsed(latest.optString("id"));
    MailMateNativeModule.emitChange("otpJournalChanged");
  }

  static void markOverlayUsed(String id) {
    if (active != null) active.renderUsed(id);
  }

  private void renderUsed(String id) {
    if (latest == null || !id.equals(latest.optString("id"))) return;
    try { latest.put("used", true); } catch (org.json.JSONException ignored) {}
    renderOverlay();
  }

  private enum SyncState { STARTING, READY, RETRYING }

  private final class AccountMonitor extends Thread {
    private final String email, password;
    private final Semaphore wake = new Semaphore(0);
    private volatile boolean running = true;
    private final List<CompletableFuture<Void>> pendingChecks = new ArrayList<>();
    private volatile SyncState state = SyncState.STARTING;

    private void setState(SyncState next) {
      if (state == next) return;
      state = next;
      main.post(() -> MailMateNativeModule.emitChange("syncStatusChanged"));
    }

    AccountMonitor(String email, String password) {
      super("MailMate Gmail sync");
      this.email = email;
      this.password = password;
    }

    synchronized CompletableFuture<Void> requestCheck() {
      CompletableFuture<Void> result = new CompletableFuture<>();
      pendingChecks.add(result);
      if (wake.availablePermits() == 0) wake.release();
      return result;
    }

    private synchronized List<CompletableFuture<Void>> takeChecks() {
      wake.drainPermits();
      List<CompletableFuture<Void>> checks = new ArrayList<>(pendingChecks);
      pendingChecks.clear();
      return checks;
    }

    void stopMonitoring() {
      running = false;
      finishChecks(takeChecks(), new IllegalStateException("Gmail sync stopped."));
      wake.release();
    }

    private void finishChecks(List<CompletableFuture<Void>> checks, Exception failure) {
      for (CompletableFuture<Void> check : checks) {
        if (failure == null) check.complete(null);
        else check.completeExceptionally(failure);
      }
    }

    @Override public void run() {
      long retrySeconds = 2;
      Store store = null;
      try {
        while (running) {
          List<CompletableFuture<Void>> checks = takeChecks();
          Exception failure = null;
          long nextCheck;
          try {
            if (store == null) store = MailMateNativeModule.connect(email, password);
            UnreadInbox.scan(store, this::checkUnread);
            if (!running) throw new IllegalStateException("Gmail sync stopped.");
            setState(SyncState.READY);
            retrySeconds = 2;
            nextCheck = 3;
          } catch (Exception error) {
            failure = error;
            setState(SyncState.RETRYING);
            nextCheck = retrySeconds;
            retrySeconds = Math.min(retrySeconds * 2, 30);
          }
          finishChecks(checks, failure);
          if (failure != null) {
            closeStore(store);
            store = null;
          }
          if (running) wake.tryAcquire(nextCheck, TimeUnit.SECONDS);
        }
      } catch (InterruptedException interrupted) {
        Thread.currentThread().interrupt();
      } finally {
        closeStore(store);
        finishChecks(takeChecks(), new IllegalStateException("Gmail sync stopped."));
      }
    }

    private void closeStore(Store store) {
      if (store == null) return;
      try { store.close(); } catch (MessagingException ignored) {}
    }

    private void checkUnread(Message[] unread) throws Exception {
      Exception firstFailure = null;
      for (Message message : unread) {
        if (!running) return;
        try {
          if (message instanceof com.sun.mail.imap.IMAPMessage) {
            ((com.sun.mail.imap.IMAPMessage) message).setPeek(true);
          }
          String code = MailParser.code(message);
          if (!running) return;
          if (code != null) {
            JSONObject item = MailMateNativeModule.toOtpItem(email, message, code);
            if (OtpJournal.save(FloatingService.this, item)) {
              main.post(() -> {
                if (!running) return;
                if (latest == null || item.optLong("receivedAt") >= latest.optLong("receivedAt")) {
                  latest = item;
                  renderOverlay();
                }
                MailMateNativeModule.emitChange("otpJournalChanged");
              });
            }
          }
          message.setFlag(Flags.Flag.SEEN, true);
        } catch (MessageRemovedException ignored) {
          // Another Gmail client removed this message.
        } catch (MessagingException | java.io.IOException error) {
          // Leave failed messages unread and continue processing the rest of this batch.
          if (firstFailure == null) firstFailure = error;
        } catch (Exception ignored) {
          message.setFlag(Flags.Flag.SEEN, true);
        }
      }
      if (firstFailure != null) throw firstFailure;
    }
  }

  @Override public void onDestroy() {
    for (AccountMonitor worker : monitors.values()) worker.stopMonitoring();
    monitors.clear();
    active = null;
    hideOverlay();
    MailMateNativeModule.emitChange("overlayClosed");
    MailMateNativeModule.emitChange("syncStatusChanged");
    stopForeground(true);
    super.onDestroy();
  }

  @Override public IBinder onBind(Intent intent) { return null; }
}

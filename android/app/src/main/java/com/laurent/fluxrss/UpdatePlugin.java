package com.laurent.fluxrss;

import android.app.Dialog;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.view.KeyEvent;
import android.view.ViewGroup;
import android.view.Window;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.ImageButton;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;
import androidx.fragment.app.FragmentActivity;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

@CapacitorPlugin(name = "UpdatePlugin")
public class UpdatePlugin extends Plugin {

    /* ── Biométrie ─────────────────────────────────────────────────────── */

    @PluginMethod
    public void authenticate(PluginCall call) {
        String reason = call.getString("reason", "Accès à votre magazine");
        FragmentActivity activity = getActivity();
        BiometricPrompt.PromptInfo promptInfo = new BiometricPrompt.PromptInfo.Builder()
            .setTitle("📖 Magazine")
            .setSubtitle(reason)
            .setAllowedAuthenticators(
                BiometricManager.Authenticators.BIOMETRIC_STRONG |
                BiometricManager.Authenticators.DEVICE_CREDENTIAL)
            .build();
        BiometricPrompt prompt = new BiometricPrompt(activity,
            ContextCompat.getMainExecutor(activity),
            new BiometricPrompt.AuthenticationCallback() {
                @Override
                public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult r) {
                    call.resolve();
                }
                @Override
                public void onAuthenticationError(int code, CharSequence msg) {
                    call.reject("auth_error", msg.toString());
                }
                @Override
                public void onAuthenticationFailed() { /* l'utilisateur réessaie */ }
            });
        activity.runOnUiThread(() -> prompt.authenticate(promptInfo));
    }

    /* ── WebView in-app ─────────────────────────────────────────────────── */

    @PluginMethod
    public void openInAppWebView(PluginCall call) {
        String url = call.getString("url", "https://www.cafeyn.co");
        String title = call.getString("title", "Magazine");
        int barColor = Color.parseColor(call.getString("barColor", "#7B3F00"));

        FragmentActivity activity = getActivity();
        activity.runOnUiThread(() -> {
            Dialog dialog = new Dialog(activity, android.R.style.Theme_Black_NoTitleBar_Fullscreen);
            dialog.requestWindowFeature(Window.FEATURE_NO_TITLE);

            // --- Barre du haut ---
            LinearLayout topBar = new LinearLayout(activity);
            topBar.setOrientation(LinearLayout.HORIZONTAL);
            topBar.setBackgroundColor(barColor);
            int dp8 = dp(activity, 8);
            topBar.setPadding(dp8 * 2, dp8, dp8, dp8);

            TextView titleView = new TextView(activity);
            titleView.setText(title);
            titleView.setTextColor(Color.WHITE);
            titleView.setTextSize(16);
            titleView.setTypeface(null, android.graphics.Typeface.BOLD);
            LinearLayout.LayoutParams tp = new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
            tp.gravity = android.view.Gravity.CENTER_VERTICAL;
            titleView.setLayoutParams(tp);

            ImageButton closeBtn = new ImageButton(activity);
            closeBtn.setImageResource(android.R.drawable.ic_menu_close_clear_cancel);
            closeBtn.setBackgroundColor(Color.TRANSPARENT);
            closeBtn.setColorFilter(Color.WHITE);
            closeBtn.setOnClickListener(v -> dialog.dismiss());

            topBar.addView(titleView);
            topBar.addView(closeBtn);

            // --- WebView ---
            WebView webView = new WebView(activity);
            WebSettings ws = webView.getSettings();
            ws.setJavaScriptEnabled(true);
            ws.setDomStorageEnabled(true);
            ws.setLoadWithOverviewMode(true);
            ws.setUseWideViewPort(true);
            ws.setBuiltInZoomControls(false);
            ws.setSupportZoom(false);
            ws.setUserAgentString("Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36");
            webView.setWebViewClient(new WebViewClient() {
                @Override
                public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
                    return false; // tout reste dans la WebView
                }
            });
            webView.loadUrl(url);

            // bouton retour Android navigue dans la WebView
            dialog.setOnKeyListener((d, keyCode, event) -> {
                if (keyCode == KeyEvent.KEYCODE_BACK && event.getAction() == KeyEvent.ACTION_UP) {
                    if (webView.canGoBack()) { webView.goBack(); return true; }
                    dialog.dismiss(); return true;
                }
                return false;
            });

            // --- Mise en page ---
            LinearLayout root = new LinearLayout(activity);
            root.setOrientation(LinearLayout.VERTICAL);
            LinearLayout.LayoutParams wvParams = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f);
            webView.setLayoutParams(wvParams);
            root.addView(topBar);
            root.addView(webView);

            dialog.setContentView(root);
            dialog.show();
            call.resolve();
        });
    }

    private int dp(Context ctx, int dp) {
        return Math.round(dp * ctx.getResources().getDisplayMetrics().density);
    }

    /* ── Mise à jour APK ────────────────────────────────────────────────── */

    @PluginMethod
    public void downloadAndInstall(PluginCall call) {
        String apkUrl = call.getString("url");
        if (apkUrl == null || apkUrl.isEmpty()) {
            call.reject("URL manquante");
            return;
        }

        Context ctx = getContext();
        File apkFile = new File(ctx.getCacheDir(), "fluxrss-update.apk");
        final String finalUrl = apkUrl;

        new Thread(() -> {
            try {
                downloadFile(finalUrl, apkFile);
                getActivity().runOnUiThread(() -> {
                    installApk(ctx, apkFile);
                    call.resolve();
                });
            } catch (Exception e) {
                call.reject("Erreur de téléchargement : " + e.getMessage());
            }
        }).start();
    }

    private void downloadFile(String urlStr, File dest) throws IOException {
        URL url = new URL(urlStr);
        int maxRedirects = 5;
        HttpURLConnection conn = null;
        while (maxRedirects-- > 0) {
            conn = (HttpURLConnection) url.openConnection();
            conn.setInstanceFollowRedirects(false);
            conn.setConnectTimeout(15_000);
            conn.setReadTimeout(90_000);
            conn.connect();
            int code = conn.getResponseCode();
            if (code >= 300 && code < 400) {
                String location = conn.getHeaderField("Location");
                conn.disconnect();
                url = new URL(location);
            } else {
                break;
            }
        }
        if (conn == null) throw new IOException("Connexion impossible");
        try (InputStream in = conn.getInputStream();
             FileOutputStream out = new FileOutputStream(dest)) {
            byte[] buf = new byte[16_384];
            int n;
            while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
        } finally {
            conn.disconnect();
        }
    }

    private void installApk(Context ctx, File apkFile) {
        Uri apkUri = FileProvider.getUriForFile(
            ctx, ctx.getPackageName() + ".fileprovider", apkFile);
        Intent intent = new Intent(Intent.ACTION_VIEW);
        intent.setDataAndType(apkUri, "application/vnd.android.package-archive");
        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);
        ctx.startActivity(intent);
    }
}

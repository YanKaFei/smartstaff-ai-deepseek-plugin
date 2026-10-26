<script setup lang="ts">
import { onLaunch } from '@dcloudio/uni-app';

onLaunch(() => {
  // Session is restored per-page; no network call is required to boot offline.
});
</script>

<style>
page,
body {
  --ss-bg: #0b0d0c;
  --ss-panel: #131714;
  --ss-panel-2: #181d19;
  --ss-line: #283129;
  --ss-text: #eef2ec;
  --ss-muted: #93a095;
  --ss-accent: #d8ff4f;
  --ss-accent-ink: #111608;
  --ss-danger: #ff6b57;
  --ss-warn: #ffb84d;
  --ss-ok: #64e6a2;
  --ss-blue: #8a96ff;
  background: var(--ss-bg);
  color: var(--ss-text);
  font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Helvetica Neue', sans-serif;
  font-size: 28rpx;
}

view,
text,
button,
input,
textarea,
picker {
  box-sizing: border-box;
}

.ss-page {
  min-height: 100vh;
  padding: 24rpx 28rpx calc(180rpx + env(safe-area-inset-bottom));
  background:
    radial-gradient(520rpx 360rpx at 100% -40rpx, rgba(216, 255, 79, 0.09), transparent 70%),
    var(--ss-bg);
}

.ss-card {
  background: var(--ss-panel);
  border: 1rpx solid var(--ss-line);
  border-radius: 28rpx;
  padding: 28rpx;
  margin-bottom: 22rpx;
}

.ss-card.tight { padding: 22rpx 24rpx; }

.ss-title {
  font-size: 30rpx;
  font-weight: 700;
  color: var(--ss-text);
  margin-bottom: 18rpx;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.ss-sub {
  font-size: 23rpx;
  color: var(--ss-muted);
  line-height: 1.55;
}

.ss-muted { color: var(--ss-muted); }
.ss-accent { color: var(--ss-accent); }
.ss-danger { color: var(--ss-danger); }
.ss-warn { color: var(--ss-warn); }
.ss-ok { color: var(--ss-ok); }

.ss-row {
  display: flex;
  align-items: center;
  gap: 16rpx;
}
.ss-spread {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16rpx;
}
.ss-wrap { flex-wrap: wrap; }

.ss-pill {
  display: inline-flex;
  align-items: center;
  padding: 6rpx 16rpx;
  border-radius: 999rpx;
  border: 1rpx solid var(--ss-line);
  color: var(--ss-muted);
  font-size: 21rpx;
  line-height: 1.3;
  white-space: nowrap;
}
.ss-pill.ok { color: var(--ss-ok); border-color: rgba(100, 230, 162, 0.35); background: rgba(100, 230, 162, 0.08); }
.ss-pill.warn { color: var(--ss-warn); border-color: rgba(255, 184, 77, 0.35); background: rgba(255, 184, 77, 0.08); }
.ss-pill.bad { color: var(--ss-danger); border-color: rgba(255, 107, 87, 0.35); background: rgba(255, 107, 87, 0.08); }
.ss-pill.accent { color: var(--ss-accent); border-color: rgba(216, 255, 79, 0.4); background: rgba(216, 255, 79, 0.08); }

button {
  margin: 0;
  padding: 0;
  background: transparent;
  color: inherit;
  font-size: 28rpx;
  line-height: 1.2;
  border-radius: 20rpx;
}
button::after { border: none; }

.btn-primary {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  min-height: 96rpx;
  padding: 24rpx;
  border-radius: 22rpx;
  background: var(--ss-accent);
  color: var(--ss-accent-ink);
  font-size: 32rpx;
  font-weight: 800;
  letter-spacing: 1rpx;
}
.btn-primary[disabled] { opacity: 0.55; }
.btn-primary.large { min-height: 112rpx; font-size: 34rpx; }

.btn-ghost {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 18rpx 26rpx;
  border: 1rpx solid var(--ss-line);
  border-radius: 18rpx;
  background: transparent;
  color: var(--ss-text);
  font-size: 26rpx;
}
.btn-ghost.small { padding: 12rpx 18rpx; font-size: 22rpx; border-radius: 14rpx; }
.btn-ghost.accent { color: var(--ss-accent); border-color: rgba(216, 255, 79, 0.4); }
.btn-ghost.danger { color: var(--ss-danger); border-color: rgba(255, 107, 87, 0.35); }
.btn-ghost.ok { color: var(--ss-ok); border-color: rgba(100, 230, 162, 0.35); }
.btn-ghost[disabled] { opacity: 0.45; }

.btn-block { display: flex; width: 100%; }

.stepper {
  display: inline-flex;
  align-items: center;
  border: 1rpx solid var(--ss-line);
  border-radius: 18rpx;
  overflow: hidden;
  background: var(--ss-panel-2);
}
.stepper-btn {
  width: 72rpx;
  height: 72rpx;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 38rpx;
  color: var(--ss-accent);
}
.stepper-btn:active { background: rgba(216, 255, 79, 0.1); }
.stepper-value {
  min-width: 76rpx;
  text-align: center;
  font-size: 32rpx;
  font-weight: 800;
  font-variant-numeric: tabular-nums;
}

.field {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20rpx;
  padding: 22rpx 0;
  border-bottom: 1rpx solid var(--ss-line);
}
.field:last-child { border-bottom: none; }
.field > view:first-child { flex: 1; min-width: 0; }
.field .label { display: block; font-size: 27rpx; color: var(--ss-text); }
.field .hint { display: block; font-size: 21rpx; color: var(--ss-muted); margin-top: 4rpx; line-height: 1.45; }
.field input {
  min-width: 120rpx;
  max-width: 60%;
  text-align: right;
  font-size: 28rpx;
  color: var(--ss-text);
}
.field .unit { color: var(--ss-muted); font-size: 23rpx; margin-left: 6rpx; }

.divider { height: 1rpx; background: var(--ss-line); margin: 20rpx 0; }

.empty {
  padding: 36rpx 0;
  text-align: center;
  color: var(--ss-muted);
  font-size: 24rpx;
  line-height: 1.7;
}

.avatar {
  width: 76rpx;
  height: 76rpx;
  border-radius: 22rpx;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(216, 255, 79, 0.12);
  color: var(--ss-accent);
  font-size: 30rpx;
  font-weight: 800;
  flex-shrink: 0;
}

.mono { font-variant-numeric: tabular-nums; }
</style>

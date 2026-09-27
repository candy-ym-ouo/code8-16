<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ApiError } from '../api/client';
import { sessionApi } from '../api';
import { formatDateTime } from '../api/format';
import type { ReadingSession, SessionOverride, Trace } from '../types/domain';

const props = defineProps<{
  bookId: string;
  traces: Trace[];
}>();

function detectTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

const timezone = ref(detectTimezone());
const gapInput = ref('30');
const sessions = ref<ReadingSession[]>([]);
const overrides = ref<SessionOverride[]>([]);
const loading = ref(false);
const error = ref('');
const success = ref('');

const timezoneChoices = computed(() => {
  const current = timezone.value;
  const presets = ['UTC', 'Asia/Shanghai', 'Asia/Tokyo', 'Europe/London', 'America/New_York'];
  return [...new Set(current ? [current, ...presets] : presets)];
});

const gapMinutes = computed(() => Number(gapInput.value));

function params(): URLSearchParams {
  return new URLSearchParams({
    bookId: props.bookId,
    timezone: timezone.value,
    gapMinutes: String(gapMinutes.value || 30)
  });
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const result = await sessionApi.list(params());
    sessions.value = result.items;
    overrides.value = result.overrides;
  } catch (caught) {
    error.value = caught instanceof ApiError ? caught.message : '阅读会话复算失败';
  } finally {
    loading.value = false;
  }
}

async function recalculate(): Promise<void> {
  success.value = '';
  await load();
}

async function adjust(kind: 'MERGE' | 'SPLIT', leftTraceId: string, rightTraceId: string): Promise<void> {
  error.value = '';
  success.value = '';
  try {
    const body = { leftTraceId, rightTraceId, timezone: timezone.value, gapMinutes: gapMinutes.value };
    if (kind === 'MERGE') {
      await sessionApi.merge(props.bookId, body);
      success.value = '已合并，痕迹的时间戳保持不变';
    } else {
      await sessionApi.split(props.bookId, body);
      success.value = '已拆分，痕迹的时间戳保持不变';
    }
    await load();
  } catch (caught) {
    error.value = caught instanceof ApiError ? caught.message : '调整失败';
  }
}

async function revoke(override: SessionOverride): Promise<void> {
  const label = override.kind === 'MERGE' ? '合并' : '拆分';
  if (!window.confirm(`撤销这次${label}调整吗？撤销后按当前时区与间隔重新复算，审计记录仍会保留。`)) return;
  error.value = '';
  try {
    await sessionApi.revoke(override.id);
    success.value = '调整已撤销，会话已重新复算';
    await load();
  } catch (caught) {
    error.value = caught instanceof ApiError ? caught.message : '撤销失败';
  }
}

function traceLabel(traceId: string): string {
  const trace = props.traces.find((item) => item.id === traceId);
  if (!trace) return '痕迹';
  const page =
    trace.type === 'ANNOTATION'
      ? trace.startPage === trace.endPage
        ? `第 ${trace.startPage} 页`
        : `第 ${trace.startPage}–${trace.endPage} 页`
      : `第 ${trace.pageNumber} 页`;
  return `${page} · ${formatDateTime(trace.createdAt)}`;
}

onMounted(load);
</script>

<template>
  <section class="card sessions-panel">
    <div class="section-heading">
      <div>
        <p class="eyebrow">READING SESSIONS</p>
        <h2>阅读会话</h2>
        <p class="muted">
          会话按同日、同书、间隔不超过设定分钟数自动聚合，是随时复算的视图；
          合并与拆分只记录调整，不会移动任何痕迹的时间。
        </p>
      </div>
    </div>

    <form class="session-controls" @submit.prevent="recalculate">
      <label>
        本地时区
        <select v-model="timezone" @change="recalculate">
          <option v-for="choice in timezoneChoices" :key="choice" :value="choice">{{ choice }}</option>
        </select>
      </label>
      <label>
        最大间隔（分钟）
        <input v-model="gapInput" type="number" min="1" max="1440" required />
      </label>
      <button class="button button-primary" type="submit" :disabled="loading">重新复算</button>
    </form>

    <p v-if="error" class="error-text">{{ error }}</p>
    <p v-if="success" class="success-text">{{ success }}</p>

    <div v-if="loading" class="state-panel">正在复算阅读会话…</div>
    <template v-else>
      <p v-if="sessions.length === 0" class="empty-inline">这本书还没有阅读痕迹，留下第一处痕迹后会话会自动出现。</p>
      <div v-else class="session-list">
        <template v-for="(session, sessionIndex) in sessions" :key="session.id">
          <div v-if="sessionIndex > 0" class="session-gap">
            <button
              class="text-button"
              type="button"
              @click="adjust('MERGE', sessions[sessionIndex - 1]!.traces[sessions[sessionIndex - 1]!.traces.length - 1]!.id, session.traces[0]!.id)"
            >
              ↑ 合并「{{ sessions[sessionIndex - 1]!.date }}」与「{{ session.date }}」两段会话
            </button>
          </div>
          <article class="session-card">
            <header class="session-card-heading">
              <div>
                <strong>{{ session.date }}</strong>
                <span v-if="session.spansMidnight" class="session-badge midnight">跨午夜</span>
                <span
                  v-for="applied in session.appliedOverrides"
                  :key="applied.id"
                  class="session-badge"
                  :class="applied.kind === 'MERGE' ? 'merged' : 'split'"
                >
                  {{ applied.kind === 'MERGE' ? '手工合并' : '手工拆分' }}
                </span>
              </div>
              <span class="muted">{{ session.traceCount }} 处痕迹</span>
            </header>
            <p class="muted">{{ formatDateTime(session.startedAt) }} — {{ formatDateTime(session.endedAt) }}</p>
            <ol class="session-traces">
              <li v-for="(trace, index) in session.traces" :key="trace.id" class="session-trace-row">
                <span>{{ traceLabel(trace.id) }}</span>
                <span v-if="index > 0" class="button-row">
                  <button
                    class="text-button danger-text"
                    type="button"
                    @click="adjust('SPLIT', session.traces[index - 1]!.id, trace.id)"
                  >
                    在此前拆分
                  </button>
                </span>
              </li>
            </ol>
          </article>
        </template>
      </div>

      <section v-if="overrides.length > 0" class="session-overrides">
        <h3>手工调整记录</h3>
        <ul>
          <li v-for="override in overrides" :key="override.id" class="override-row">
            <span>
              <strong>{{ override.kind === 'MERGE' ? '合并' : '拆分' }}</strong>
              · {{ override.timezone }} · 间隔 {{ override.gapMinutes }} 分钟
              · {{ formatDateTime(override.createdAt) }}
            </span>
            <button class="text-button danger-text" type="button" @click="revoke(override)">撤销</button>
          </li>
        </ul>
      </section>
    </template>
  </section>
</template>

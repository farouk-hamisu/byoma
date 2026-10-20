// Formatting helpers.

export function formatDate(value, options = {}) {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const locale = options.locale || undefined;
  try {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: options.dateStyle || 'medium',
      ...(options.time ? { timeStyle: options.timeStyle || 'short' } : {}),
      ...options.extra,
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

export function formatDateTime(value, locale) {
  return formatDate(value, { time: true, locale });
}

export function formatBytes(bytes) {
  const size = Number(bytes);
  if (!Number.isFinite(size) || size <= 0) return '0 KB';
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
  return `${(size / (1024 * 1024)).toFixed(size < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

export function truncate(value, max = 48) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function truncateMiddle(value, max = 56) {
  const text = String(value ?? '');
  if (text.length <= max) return text;
  const half = Math.floor((max - 1) / 2);
  return `${text.slice(0, half)}…${text.slice(text.length - half)}`;
}

export function safeHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

export const STATUS_LABELS = {
  new: 'New',
  under_review: 'Under Review',
  approved: 'Approved',
  rejected: 'Rejected',
  more_info: 'More Information Required',
};

export function statusLabel(status) {
  return STATUS_LABELS[status] || status || 'Unknown';
}

export function plural(count, singular, pluralForm = `${singular}s`) {
  return Number(count) === 1 ? singular : pluralForm;
}

export function relativeTime(value, now = Date.now()) {
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return '—';
  const diff = Math.round((time - now) / 1000);
  const units = [
    ['year', 31536000],
    ['month', 2592000],
    ['week', 604800],
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
  ];
  for (const [unit, seconds] of units) {
    if (Math.abs(diff) >= seconds) {
      const value_ = Math.round(diff / seconds);
      try {
        return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(value_, unit);
      } catch {
        return `${value_} ${unit}${Math.abs(value_) === 1 ? '' : 's'} ago`;
      }
    }
  }
  return 'just now';
}

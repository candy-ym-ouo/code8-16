export const BOOK_STATUSES = ['TO_READ', 'READING', 'READ', 'PAUSED', 'ABANDONED'];
export const MOOD_TAGS = ['MOVED', 'CALM', 'JOYFUL', 'SAD', 'ANGRY', 'CONFUSED', 'RELIEVED', 'EMPTY', 'CHANGED'];
export const TRACE_TYPES = ['DOG_EAR', 'ANNOTATION', 'REREAD_MARK'];
export const ACTIVITY_ACTIONS = ['CREATED', 'UPDATED', 'DELETED', 'RESTORED', 'STATUS_CHANGED', 'COMPLETED'];
export const ACTIVITY_ENTITY_TYPES = ['BOOK', 'DOG_EAR', 'ANNOTATION', 'REREAD_MARK', 'COMPLETION_REFLECTION', 'READING_SESSION'];
// Session edge overrides: MERGE forces two neighboring traces into one segment,
// SPLIT forces a break between them. They never alter trace timestamps.
export const SESSION_OVERRIDE_KINDS = ['MERGE', 'SPLIT'];
export const DEFAULT_SESSION_TIMEZONE = 'Asia/Shanghai';
export const DEFAULT_SESSION_GAP_MINUTES = 90;

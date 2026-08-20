import { ulid } from 'ulid';

/** Job ids are prefixed ULIDs: sortable by creation time, safe in URLs. */
export function newJobId(): string {
  return `pdf_${ulid()}`;
}

const JOB_ID_PATTERN = /^pdf_[0-9A-HJKMNP-TV-Z]{26}$/;

export function isJobId(value: string): boolean {
  return JOB_ID_PATTERN.test(value);
}

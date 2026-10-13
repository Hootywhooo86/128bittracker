export class HttpError extends Error {
  /** extra: more fields for the error body, e.g. { code: 'other_account' }. */
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export const notFound = (what) => new HttpError(404, `${what} not found`);

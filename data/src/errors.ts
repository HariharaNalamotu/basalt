export type BasaltErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'denied'
  | 'rate_limited'
  | 'unavailable'
  | 'conflict'
  | 'contract';

// Every error the Data block throws. Messages are plain English and never
// include raw database errors, SQL or other users' data.
export class BasaltError extends Error {
  code: BasaltErrorCode;

  constructor(code: BasaltErrorCode, message: string) {
    super(message);
    this.name = 'BasaltError';
    this.code = code;
  }
}

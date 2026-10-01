/** Validation levels shared by input widgets and quick input providers. */
export enum VALIDATE_TYPE {
  INFO = 1,
  ERROR = 2,
  WARNING = 3,
  IGNORE = 4,
}

export interface ValidateMessage {
  message?: string | void;
  type: VALIDATE_TYPE;
}

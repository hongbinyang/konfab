export class KonfabError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

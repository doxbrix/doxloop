export class DoxloopError extends Error {
  readonly exitCode: number

  constructor(message: string, exitCode = 1) {
    super(message)
    this.name = 'DoxloopError'
    this.exitCode = exitCode
  }
}

export class UsageError extends DoxloopError {
  constructor(message: string) {
    super(message, 2)
    this.name = 'UsageError'
  }
}

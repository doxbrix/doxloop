export interface Document {
  kind: 'document'
  source: string
}

export class ParseError extends Error {}

export function parse(source: string): Document {
  if (source.trim() === '') throw new ParseError('Input cannot be empty.')
  return { kind: 'document', source }
}

export function run(args: string[]): number {
  if (args[0] !== 'validate') return 2
  const formatIndex = args.indexOf('--format')
  const format = formatIndex >= 0 ? args[formatIndex + 1] : 'text'
  if (format !== 'text' && format !== 'json') return 2
  return args[1]?.endsWith('.yaml') ? 0 : 1
}

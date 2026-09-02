import { retryHeader } from './billing'
if (retryHeader !== 'Retry-After') throw new Error('billing contract')

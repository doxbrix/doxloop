import { describe, expect, test } from 'vitest'
import { signInWallFromObservation } from './application-probe.js'

describe('signInWallFromObservation', () => {
  test('treats a final sign-in route as a wall', () => {
    expect(signInWallFromObservation({ finalUrl: 'http://localhost:5230/auth?redirect=%2F', hasPasswordField: false })).toEqual({ signInPath: '/auth' })
    expect(signInWallFromObservation({ finalUrl: 'http://localhost:3000/login', hasPasswordField: false })).toEqual({ signInPath: '/login' })
    expect(signInWallFromObservation({ finalUrl: 'http://localhost:3000/users/sign-in', hasPasswordField: false })).toEqual({ signInPath: '/users/sign-in' })
    expect(signInWallFromObservation({ finalUrl: 'http://localhost:3000/auth/signin', hasPasswordField: true })).toEqual({ signInPath: '/auth/signin' })
  })

  test('reads hash-routed sign-in screens', () => {
    expect(signInWallFromObservation({ finalUrl: 'http://127.0.0.1:8090/_/#/login', hasPasswordField: false })).toEqual({ signInPath: '/_/#/login' })
  })

  test('treats a visible password field as a wall even on an ordinary route', () => {
    expect(signInWallFromObservation({ finalUrl: 'http://localhost:3000/', hasPasswordField: true })).toEqual({ signInPath: '/' })
  })

  test('leaves the signed-out-but-open application alone', () => {
    expect(signInWallFromObservation({ finalUrl: 'http://localhost:3000/dashboard', hasPasswordField: false })).toBeUndefined()
    expect(signInWallFromObservation({ finalUrl: 'http://localhost:3000/author/articles', hasPasswordField: false })).toBeUndefined()
    expect(signInWallFromObservation({ finalUrl: 'http://localhost:3000/_/#/collections', hasPasswordField: false })).toBeUndefined()
  })
})

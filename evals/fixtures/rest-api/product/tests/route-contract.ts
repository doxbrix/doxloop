export const contract = {
  method: 'GET',
  path: '/widgets/{id}',
  missingStatus: 404,
  authentication: 'Authorization: Bearer <token>',
}

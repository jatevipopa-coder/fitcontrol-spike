// Errores tipados de la capa de datos.
export class ValidationError extends Error {
  constructor(errors) {
    super('Datos no válidos: ' + errors.map((e) => e.field + ': ' + e.message).join('; '));
    this.name = 'ValidationError';
    this.errors = errors;
  }
}
export class ConflictError extends Error {
  constructor(message) { super(message); this.name = 'ConflictError'; }
}
export class NotFoundError extends Error {
  constructor(what) { super(what + ' no encontrado'); this.name = 'NotFoundError'; }
}

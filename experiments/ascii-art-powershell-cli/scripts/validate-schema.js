'use strict';

function typeMatches(value, type) {
  switch (type) {
    case 'null': return value === null;
    case 'array': return Array.isArray(value);
    case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'integer': return Number.isInteger(value);
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    default: return typeof value === type;
  }
}

function resolveRef(rootSchema, reference) {
  if (!reference.startsWith('#/')) {
    throw new Error(`Only local schema references are supported: ${reference}`);
  }
  return reference.slice(2).split('/').reduce((value, segment) => value[segment], rootSchema);
}

function validateSchema(instance, schema, rootSchema = schema, location = '$') {
  const errors = [];
  if (schema.$ref) {
    return validateSchema(instance, resolveRef(rootSchema, schema.$ref), rootSchema, location);
  }
  if (schema.oneOf) {
    const matches = schema.oneOf.filter((candidate) => validateSchema(instance, candidate, rootSchema, location).length === 0);
    if (matches.length !== 1) errors.push(`${location} must match exactly one oneOf branch`);
    return errors;
  }
  if (Object.hasOwn(schema, 'const') && JSON.stringify(instance) !== JSON.stringify(schema.const)) {
    errors.push(`${location} must equal the schema constant`);
  }
  if (schema.enum && !schema.enum.some((value) => JSON.stringify(value) === JSON.stringify(instance))) {
    errors.push(`${location} is not an allowed enum value`);
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => typeMatches(instance, type))) {
      errors.push(`${location} must have type ${types.join('|')}`);
      return errors;
    }
  }
  if (typeof instance === 'string') {
    if (schema.minLength !== undefined && instance.length < schema.minLength) errors.push(`${location} is too short`);
    if (schema.maxLength !== undefined && instance.length > schema.maxLength) errors.push(`${location} is too long`);
    if (schema.pattern && !(new RegExp(schema.pattern)).test(instance)) errors.push(`${location} does not match ${schema.pattern}`);
    if (schema.format === 'date-time' && Number.isNaN(Date.parse(instance))) errors.push(`${location} is not a date-time`);
  }
  if (typeof instance === 'number') {
    if (schema.minimum !== undefined && instance < schema.minimum) errors.push(`${location} is below minimum`);
    if (schema.maximum !== undefined && instance > schema.maximum) errors.push(`${location} is above maximum`);
    if (schema.multipleOf !== undefined) {
      const quotient = instance / schema.multipleOf;
      if (Math.abs(quotient - Math.round(quotient)) > 1e-9) errors.push(`${location} is not a multiple of ${schema.multipleOf}`);
    }
  }
  if (Array.isArray(instance)) {
    if (schema.minItems !== undefined && instance.length < schema.minItems) errors.push(`${location} has too few items`);
    if (schema.items) {
      instance.forEach((value, index) => errors.push(...validateSchema(value, schema.items, rootSchema, `${location}[${index}]`)));
    }
  }
  if (instance !== null && typeof instance === 'object' && !Array.isArray(instance)) {
    const properties = schema.properties || {};
    for (const required of schema.required || []) {
      if (!Object.hasOwn(instance, required)) errors.push(`${location}.${required} is required`);
    }
    for (const [name, value] of Object.entries(instance)) {
      if (properties[name]) {
        errors.push(...validateSchema(value, properties[name], rootSchema, `${location}.${name}`));
      } else if (schema.additionalProperties === false) {
        errors.push(`${location}.${name} is not allowed`);
      }
    }
  }
  return errors;
}

module.exports = { validateSchema };

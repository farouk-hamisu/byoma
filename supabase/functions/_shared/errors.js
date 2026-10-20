// Public error mapping: internal details never reach applicants.

const SIMPLE = {
  applications_paused: [403, 'applications_paused', 'Applications are currently closed. Please check back later.'],
  consent_required: [422, 'consent_required', 'Please accept the Terms and Conditions before submitting.'],
  terms_version_mismatch: [422, 'terms_version_mismatch', 'The Terms and Conditions were updated. Please review and accept the current version.'],
  terms_unavailable: [503, 'terms_unavailable', 'The Terms and Conditions are not available right now. Please try again later.'],
  invalid_url: [422, 'invalid_url', 'One of the URLs you entered is not valid.'],
  product_incomplete: [422, 'product_incomplete', 'Each product needs a name, a URL, or an image.'],
  min_products: [422, 'min_products', 'Please select the minimum number of products required.'],
  max_products: [422, 'max_products', 'You have reached the maximum number of products.'],
  rate_limited: [429, 'rate_limited', 'Too many attempts. Please wait a moment and try again.'],
  upload_missing: [422, 'upload_missing', 'One of your product images could not be found. Please upload it again.'],
  invalid_upload_path: [422, 'invalid_upload_path', 'One of your uploads could not be verified.'],
  invalid_file_type: [422, 'invalid_file_type', 'One of the uploaded files is not a supported image type.'],
  file_too_large: [422, 'file_too_large', 'One of the uploaded files is too large.'],
  invalid_file: [422, 'invalid_file', 'One of the uploaded files is not valid.'],
  invalid_payload: [400, 'invalid_payload', 'The submitted information could not be processed. Please try again.'],
  payload_too_large: [413, 'payload_too_large', 'The submitted information is too large.'],
  invalid_json: [400, 'invalid_json', 'The request could not be read. Please try again.'],
  method_not_allowed: [405, 'method_not_allowed', 'Method not allowed.'],
  forbidden: [403, 'forbidden', 'You do not have permission to perform this action.'],
  not_found: [404, 'not_found', 'The requested record was not found.'],
  version_exists: [409, 'version_exists', 'That version number already exists.'],
  invalid_reviewer: [422, 'invalid_reviewer', 'The selected reviewer is not available.'],
  invalid_product_limits: [422, 'invalid_product_limits', 'Product limits must be between 1 and 30, with a minimum below the maximum.'],
  not_current: [409, 'not_current', 'That document is not the published version.'],
  is_current: [409, 'is_current', 'Unpublish the current version before deleting it.'],
  terms_in_use: [409, 'terms_in_use', 'That version was accepted by applicants and cannot be deleted.'],
  upload_failed: [502, 'upload_failed', 'The upload could not be completed. Please try again.'],
  service_unavailable: [503, 'service_unavailable', 'The service is temporarily unavailable. Please try again.'],
  missing_env: [500, 'server_error', 'Something went wrong. Please try again.'],
};

// Codes shaped like "<key>:<detail>" where detail is a field key or product position.
const DYNAMIC = {
  required_field: [422, 'required_field', 'Please complete all required fields.'],
  invalid_field: [422, 'invalid_field', 'Some of the information you entered is not valid.'],
  unsafe_content: [422, 'unsafe_content', 'Some of the content you entered is not allowed.'],
  invalid_setting: [422, 'invalid_setting', 'One of the values you entered is not allowed.'],
  unknown_field: [422, 'unknown_field', 'One of the form fields is not recognised.'],
};

export function isRateLimited(error) {
  return String(error?.message || error || '').includes('rate_limited');
}

export function publicError(code, status = null, message = null) {
  const preset = SIMPLE[code];
  if (preset) {
    return { status: preset[0], body: { error: { code: preset[1], message: preset[2] } } };
  }
  return {
    status: status || 500,
    body: {
      error: { code, message: message || 'Something went wrong. Please try again.' },
    },
  };
}

export function rateLimited() {
  return publicError('rate_limited');
}

// Translate a PostgREST / database error into a safe public response.
export function mapDatabaseError(error) {
  const message = String(error?.message || '');
  const sqlState = String(error?.code || '');
  const [key, detail] = message.includes(':')
    ? [message.slice(0, message.indexOf(':')), message.slice(message.indexOf(':') + 1)]
    : [message, null];

  if (SIMPLE[key]) {
    return publicError(key);
  }
  if (DYNAMIC[key]) {
    const [status, code, text] = DYNAMIC[key];
    const body = { error: { code, message: text } };
    if (key === 'product_incomplete') {
      body.error.index = detail ? Number(detail) - 1 : null;
    } else if (detail) {
      body.error.field = detail;
    }
    return { status, body };
  }
  if (sqlState === '42501') {
    return publicError('forbidden');
  }
  console.error('unmapped database error', { sqlState, message, details: error?.details });
  return publicError('server_error', 500, 'Something went wrong. Please try again.');
}

export function errorResponse(mapped) {
  return mapped;
}

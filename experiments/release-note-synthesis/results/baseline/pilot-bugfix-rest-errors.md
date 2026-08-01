# GitHub CLI: Fix RESTWithNext error type, repairing gh status and attestation retries

## Fixed

- RESTWithNext did not wrap go-gh errors into the API HTTP error type as REST does. This broke two user-visible behaviors: gh status should gracefully degrade when notifications or events are inaccessible, and gh attestation commands should retry attestation fetching for HTTP 500 responses. The change makes programmatic errors.As checks for api.HTTPError work consistently. It is also groundwork for per-host API routing, but that implementation detail is not the customer-facing focus.

## References

- https://github.com/cli/cli/pull/13988

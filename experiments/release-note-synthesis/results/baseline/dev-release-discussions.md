# GitHub CLI: add --discussion-category flag to release cmd

## New

- Flag for signaling that a discussion should be created with the given category for the release. Discussions are not supported for draft releases. If a discussion category is given for a draft, an error will be shown. Closes #3381.

## References

- https://github.com/cli/cli/pull/4003
- https://github.com/cli/cli/issues/3381

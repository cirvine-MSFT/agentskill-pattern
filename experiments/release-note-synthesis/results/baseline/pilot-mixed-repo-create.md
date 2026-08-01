# GitHub CLI: rewrite gh repo create

## Breaking changes

- The gh repo create command was rewritten to fix bugs, improve UX, and add requested features. Interactive mode now applies only when no arguments are supplied; otherwise all arguments must be explicit. Script behavior changes: new repositories are no longer cloned by default (use --clone); behavior no longer changes merely because the current directory is a Git repository; use --source to create from an existing local repository. New flags are --source, --remote, and --push. Deprecated flags are --enable-wiki (use --disable-wiki), --enable-issues (use --disable-issues), and --confirm. Running gh repo create myrepo --public inside a local repository now creates only the GitHub repository; use --source=. to create from that local repository.

## Fixed

- Addresses fatal: remote origin already exists when creating repo; Remote repository configured; Git initialization does not happen after creating a repo in a node.js app; Letting the user specify the base init dir for the newly created repo.

## References

- https://github.com/cli/cli/pull/4578
- https://github.com/cli/cli/issues/2166
- https://github.com/cli/cli/issues/893
- https://github.com/cli/cli/issues/2059
- https://github.com/cli/cli/issues/2077

# ProctorGuard AI security_spec.md

## Data Invariants
1. A Violation must belong to a valid Session owned by the user.
2. Users can only read and write their own profile and sessions.
3. Once a Session is marked as 'completed', it should be immutable except maybe for admin corrections (if any).
4. Timestamp fields MUST use server time.

## The "Dirty Dozen" Payloads
1. Attempt to create a User profile with a different UID.
2. Attempt to read another user's profile.
3. Attempt to create a Session for another user.
4. Attempt to update a Session status to 'completed' without being the owner.
5. Attempt to create a Violation for a Session not owned by the user.
6. Attempt to inject a large junk string into the Violation description.
7. Attempt to update the `startTime` of an existing Session.
8. Attempt to delete a Violation log (should be append-only).
9. Attempt to create a user profile with an unverified email (if policy requires verification).
10. Attempt to update a Session after it is completed.
11. Attempt to set `integrityScore` to 1000 (out of bounds).
12. Attempt to list all Sessions in the database without a user filter.

## Test Runner (Simplified Logic)
- `test('prevent spoofing uid', ...)`
- `test('prevent cross-user read', ...)`
- `test('validate session status enum', ...)`
- `test('ensure server timestamp for violation', ...)`

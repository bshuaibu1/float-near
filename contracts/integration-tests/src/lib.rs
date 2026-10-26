//! No library code. This crate exists only to host `tests/`, which run
//! against a real local NEAR sandbox node.
//!
//! Everything here is invisible to the unit tier in `contracts/vault/src/tests.rs`,
//! because a unit test cannot schedule a promise and so never executes the
//! transfer callback: reservation release (I6), failed-transfer recovery (I8),
//! the day boundary, and concurrency exactness.

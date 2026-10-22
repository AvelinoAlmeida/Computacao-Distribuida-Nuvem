'use strict';
// Pure helpers for the notification worker (unit-tested).

// NOTIFY_FAIL_RATE (0..1): probability that one delivery attempt fails.
const shouldFail = (rate, random = Math.random) => rate > 0 && random() < rate;

// Failure policy for queue messages: the first failure requeues the message (one more try, possibly on another consumer);
// a failure on a redelivered message sends it to the dead-letter queue instead of looping forever.
const onFailure = (message) => (message.fields.redelivered ? 'dead-letter' : 'requeue');

module.exports = { shouldFail, onFailure };

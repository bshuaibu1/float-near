//! Minimal NEP-141 for vault integration tests. TEST ARTIFACT — never deployed.
//!
//! This is deliberately NOT a faithful token. It exists to produce, on demand,
//! the three failure modes the vault's reservation path must survive:
//!
//!   1. forced panic mid-transfer   `set_fail_transfers(true)` -> tests I6
//!   2. honest insufficient balance mint less than you pay    -> tests I8
//!   3. unregistered receiver       `unregister(account)`      -> the realistic
//!                                                                production case
//!
//! There is NO delay hook. Holding a transfer open across midnight would need
//! promise yield/resume; instead the vault's day LENGTH is shortened in the
//! sandbox (see integration-tests/tests/common.rs), which is deterministic
//! because a callback always lands at least one block after its request.

use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{assert_one_yocto, env, near, AccountId, BorshStorageKey, PanicOnDefault};

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Accounts,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct MockFt {
    /// Registered accounts and their balances. ABSENCE means not registered,
    /// which is what makes failure mode 3 reachable.
    accounts: LookupMap<AccountId, u128>,
    total_supply: u128,
    /// When true, every `ft_transfer` panics until explicitly disarmed.
    ///
    /// Deliberately a latch and NOT a countdown. A countdown cannot work: the
    /// decrement would live in the same receipt as `env::panic_str`, and a
    /// panic reverts every state change in its receipt — so the counter would
    /// never actually fall, and a test asserting "the failure was consumed"
    /// would read a stale value and fail for a misleading reason. (It did,
    /// which is how this was found.)
    fail_transfers: bool,
    /// Transfers that actually moved value. Asserted by the tests: without it,
    /// a run where no transfer ever fired would still satisfy "the cap was not
    /// exceeded", which is the fake-coverage trap.
    transfer_count: u64,
}

#[near]
impl MockFt {
    #[init]
    pub fn new() -> Self {
        Self {
            accounts: LookupMap::new(StorageKey::Accounts),
            total_supply: 0,
            fail_transfers: false,
            transfer_count: 0,
        }
    }

    // ------------------------------------------------------------- NEP-141

    /// Panics on failure; never returns an error value.
    ///
    /// This matters: NEP-141 transfers fail by panicking, and the vault's
    /// callback distinguishes success from failure via `promise_result`. A
    /// mock that returned `false` instead would leave the vault's failure
    /// branch unreachable and make M9 (drop the reservation release)
    /// unkillable.
    #[payable]
    pub fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        assert_one_yocto();
        let _ = memo;

        if self.fail_transfers {
            // No bookkeeping before this: a panic reverts the whole receipt,
            // so anything written here would be rolled back anyway.
            env::panic_str("MOCK_FT_FORCED_FAILURE");
        }

        let sender = env::predecessor_account_id();
        let amount = amount.0;
        if amount == 0 {
            env::panic_str("The amount should be a positive number");
        }

        let sender_bal = self
            .accounts
            .get(&sender)
            .copied()
            .unwrap_or_else(|| env::panic_str("The account is not registered"));

        // Receiver registration is enforced on purpose. Paying an allowlisted
        // but unregistered recipient is a real production failure, and the
        // vault must release its reservation when it happens.
        let recv_bal = self
            .accounts
            .get(&receiver_id)
            .copied()
            .unwrap_or_else(|| env::panic_str("The account receiver_id is not registered"));

        let remaining = sender_bal
            .checked_sub(amount)
            .unwrap_or_else(|| env::panic_str("The account doesn't have enough balance"));

        self.accounts.insert(sender, remaining);
        self.accounts.insert(receiver_id, recv_bal + amount);
        self.transfer_count += 1;
    }

    pub fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        U128(self.accounts.get(&account_id).copied().unwrap_or(0))
    }

    pub fn ft_total_supply(&self) -> U128 {
        U128(self.total_supply)
    }

    /// Registration only. Storage accounting is irrelevant here, so any
    /// attached deposit is accepted and ignored.
    #[payable]
    pub fn storage_deposit(&mut self, account_id: Option<AccountId>) {
        let who = account_id.unwrap_or_else(env::predecessor_account_id);
        if self.accounts.get(&who).is_none() {
            self.accounts.insert(who, 0);
        }
    }

    pub fn storage_balance_of(&self, account_id: AccountId) -> Option<U128> {
        self.accounts.get(&account_id).map(|_| U128(0))
    }

    // -------------------------------------------------------- test controls

    pub fn mint(&mut self, account_id: AccountId, amount: U128) {
        let bal = self.accounts.get(&account_id).copied().unwrap_or(0);
        self.accounts.insert(account_id, bal + amount.0);
        self.total_supply += amount.0;
    }

    /// Arm or disarm forced transfer failure. Stays armed until disarmed.
    pub fn set_fail_transfers(&mut self, fail: bool) {
        self.fail_transfers = fail;
    }

    /// De-register an account so transfers TO it panic.
    pub fn unregister(&mut self, account_id: AccountId) {
        self.accounts.remove(&account_id);
    }

    /// Reads the latch. Proves the hook is ARMED; it cannot prove the hook
    /// fired, because the firing receipt panics and leaves no trace here. The
    /// test proves firing by matching MOCK_FT_FORCED_FAILURE in the receipt
    /// outcome instead.
    pub fn fail_transfers_armed(&self) -> bool {
        self.fail_transfers
    }

    /// Positive control: proves value genuinely moved (or genuinely did not).
    pub fn transfer_count(&self) -> u64 {
        self.transfer_count
    }
}

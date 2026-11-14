# STAGED MAINNET COMMANDS - run these yourself, one line each.
# Generated and round-trip validated. Do not reformat: the \" escaping is
# required because PowerShell strips bare quotes from native-exe args.

# STEP 1 - bind the 'demo' agent (0.12 NEAR, recoverable, not a fee)
near contract call-function as-transaction test015-near.usefloat.near add_role json-args '{\"label\":\"demo\",\"limits\":[{\"token\":\"17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1\",\"daily_cap\":\"5000000\",\"per_tx_cap\":\"1000000\"}],\"cooldown_sec\":0,\"recipients\":null,\"public_key\":\"ed25519:EJmg2Te2zLnbCZC4wGcV2LE4dkQfPD1ddiYqjSvRG1re\"}' prepaid-gas "100.0 Tgas" attached-deposit "0.12 NEAR" sign-as test015.near network-config mainnet sign-with-keychain send

# STEP 2 - fund the vault with 2 USDC
near contract call-function as-transaction 17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1 ft_transfer json-args '{\"receiver_id\":\"test015-near.usefloat.near\",\"amount\":\"2000000\"}' prepaid-gas "30.0 Tgas" attached-deposit "1 yoctoNEAR" sign-as test015.near network-config mainnet sign-with-keychain send

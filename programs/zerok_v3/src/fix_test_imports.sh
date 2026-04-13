#!/bin/bash
# Make all test module imports conditional
sed -i 's/^mod poseidon_test;/#[cfg(test)]\nmod poseidon_test;/' lib.rs
sed -i 's/^mod integration_tests;/#[cfg(test)]\nmod integration_tests;/' lib.rs
sed -i 's/^mod simple_test;/#[cfg(test)]\nmod simple_test;/' lib.rs
sed -i 's/^mod nullifier_pda_test;/#[cfg(test)]\nmod nullifier_pda_test;/' lib.rs
sed -i 's/^mod final_verification_test;/#[cfg(test)]\nmod final_verification_test;/' lib.rs
sed -i 's/^mod relayer_security_test;/#[cfg(test)]\nmod relayer_security_test;/' lib.rs
sed -i 's/^mod vault_pda_tests;/#[cfg(test)]\nmod vault_pda_tests;/' lib.rs
sed -i 's/^mod mini_poseidon_test;/#[cfg(test)]\nmod mini_poseidon_test;/' lib.rs
echo 'Fixed all test module imports'

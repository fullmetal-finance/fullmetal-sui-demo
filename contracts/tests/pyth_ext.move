// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0
//
// TOOLCHAIN SHIM (test-only). deepbook_margin's bundled tests declare exactly
// this extension in their own tests/ dir, but sui 1.74.x compiles a DEPENDENCY's
// tests without applying the dependency's cross-package `extend module`s, so
// `pyth::price_info::new_price_info_object_for_test` comes up unbound. Root-
// package extensions ARE applied graph-wide, so re-declaring it here (verbatim
// from deepbookv3 packages/deepbook_margin/tests/helper/price_info_ext.move,
// rev 0123465) makes `sui move test` link. Requires `pyth` assigned in our
// [addresses] (same value pyth's own manifest declares). Never published:
// #[test_only] code is stripped from release bytecode.
#[test_only]
extend module pyth::price_info;

public fun new_price_info_object_for_test(
    price_info: PriceInfo,
    ctx: &mut TxContext,
): PriceInfoObject {
    PriceInfoObject {
        id: object::new(ctx),
        price_info,
    }
}

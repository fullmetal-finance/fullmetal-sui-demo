/// Protocol-global governance: the one place a single OTW-bound registry is
/// correct. Holds the allowlist of external OTC/rehypo module witness
/// type-names trusted to move institution margin, plus the platform super-admin
/// cap. Governs ONLY protocol concerns — never a tenant's funds.
module fullmetal::protocol;

use std::ascii;
use sui::table::{Self, Table};
use fullmetal::errors;
use fullmetal::events;

/// One-time witness — name == module uppercased — forces the singleton at publish.
public struct PROTOCOL has drop {}

/// Global platform super-admin. key+store so the platform can custody/transfer it.
public struct ProtocolCap has key, store {
    id: UID,
}

/// Singleton shared object: allowlist of OTC/rehypo module witness type-names.
public struct OtcAllowlist has key {
    id: UID,
    witnesses: Table<ascii::String, bool>, // type_name(W) -> enabled
}

fun init(_otw: PROTOCOL, ctx: &mut TxContext) {
    init_internal(ctx);
}

// Sends the founding ProtocolCap to the publisher — standard init pattern.
#[allow(lint(self_transfer))]
fun init_internal(ctx: &mut TxContext) {
    let allow = OtcAllowlist { id: object::new(ctx), witnesses: table::new<ascii::String, bool>(ctx) };
    transfer::share_object(allow);
    let cap = ProtocolCap { id: object::new(ctx) };
    transfer::public_transfer(cap, ctx.sender());
}

#[test_only]
public fun init_for_testing(ctx: &mut TxContext) { init_internal(ctx) }

/// Allow an OTC/rehypo witness type-name to move margin. Holding `ProtocolCap` is auth.
public fun allow_otc_witness(
    allow: &mut OtcAllowlist,
    _cap: &ProtocolCap,
    witness_type: ascii::String,
    ctx: &mut TxContext,
) {
    if (table::contains(&allow.witnesses, witness_type)) {
        *table::borrow_mut(&mut allow.witnesses, witness_type) = true;
    } else {
        table::add(&mut allow.witnesses, witness_type, true);
    };
    events::emit_otc_witness_allowed(witness_type, ctx.sender());
}

/// Kill-switch: de-authorize a witness type-name (e.g. a buggy OTC version).
public fun remove_otc_witness(
    allow: &mut OtcAllowlist,
    _cap: &ProtocolCap,
    witness_type: ascii::String,
    ctx: &mut TxContext,
) {
    assert!(table::contains(&allow.witnesses, witness_type), errors::e_witness_not_allowed());
    *table::borrow_mut(&mut allow.witnesses, witness_type) = false;
    events::emit_otc_witness_removed(witness_type, ctx.sender());
}

/// True iff `name` is present and enabled. Called by the margin/settlement seams.
public fun is_witness_allowed(allow: &OtcAllowlist, name: &ascii::String): bool {
    if (!table::contains(&allow.witnesses, *name)) {
        false
    } else {
        *table::borrow(&allow.witnesses, *name)
    }
}

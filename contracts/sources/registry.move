/// Singleton handle -> Institution-ID registry: the canonical, race-free
/// institution identity. `table::add` aborting on a duplicate key IS the
/// uniqueness guarantee (tx atomicity removes any read-then-write hazard).
/// SuiNS is deliberately NOT used — it has no Move-callable registration, its
/// name->target is mutable and documented as not an identity primitive, and it
/// costs SUI + a renewal lifecycle per institution. A vanity .sui name is kept
/// as an optional display-only field on the Institution instead.
module fullmetal::registry;

use std::string::String;
use sui::table::{Self, Table};
use fullmetal::errors;

const MIN_HANDLE_LEN: u64 = 3;
const MAX_HANDLE_LEN: u64 = 32;

/// One-time witness.
public struct REGISTRY has drop {}

/// Singleton shared registry. The forward table is the uniqueness source of truth.
public struct HandleRegistry has key {
    id: UID,
    handles: Table<String, ID>, // handle  -> Institution object ID (unique)
    reverse: Table<ID, String>, // inst ID -> handle (display / reverse lookup)
}

fun init(_otw: REGISTRY, ctx: &mut TxContext) {
    init_internal(ctx);
}

fun init_internal(ctx: &mut TxContext) {
    let reg = HandleRegistry {
        id: object::new(ctx),
        handles: table::new<String, ID>(ctx),
        reverse: table::new<ID, String>(ctx),
    };
    transfer::share_object(reg);
}

#[test_only]
public fun init_for_testing(ctx: &mut TxContext) { init_internal(ctx) }

/// Bind a validated, unique handle to an Institution ID. Package-internal:
/// only `institution::create_institution` calls it, atomically with creation.
public(package) fun insert(reg: &mut HandleRegistry, handle: String, inst_id: ID) {
    assert!(validate_handle(&handle), errors::e_handle_invalid());
    assert!(!table::contains(&reg.handles, handle), errors::e_handle_taken());
    table::add(&mut reg.handles, handle, inst_id);
    table::add(&mut reg.reverse, inst_id, handle);
}

public fun is_taken(reg: &HandleRegistry, handle: &String): bool {
    table::contains(&reg.handles, *handle)
}

/// Forward lookup — future OTC counterparty-by-handle resolution inside Move.
public fun resolve(reg: &HandleRegistry, handle: &String): Option<ID> {
    if (table::contains(&reg.handles, *handle)) {
        option::some(*table::borrow(&reg.handles, *handle))
    } else {
        option::none()
    }
}

/// Reverse lookup — display the handle for an institution.
public fun handle_of(reg: &HandleRegistry, inst_id: ID): Option<String> {
    if (table::contains(&reg.reverse, inst_id)) {
        option::some(*table::borrow(&reg.reverse, inst_id))
    } else {
        option::none()
    }
}

/// Charset `a-z0-9-`, length in [3,32], no leading/trailing hyphen, not empty.
/// Lowercase-only means no case-fold ambiguity in the uniqueness key.
fun validate_handle(h: &String): bool {
    let bytes = h.as_bytes();
    let len = bytes.length();
    if (len < MIN_HANDLE_LEN || len > MAX_HANDLE_LEN) return false;
    let mut i = 0;
    while (i < len) {
        let b = *bytes.borrow(i);
        let ok = (b >= 0x61 && b <= 0x7a) || (b >= 0x30 && b <= 0x39) || b == 0x2d;
        if (!ok) return false;
        if (b == 0x2d && (i == 0 || i == len - 1)) return false; // no leading/trailing '-'
        i = i + 1;
    };
    true
}

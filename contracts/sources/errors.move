/// Canonical error-code registry for the Fullmetal package.
///
/// Move constants are module-private, so each code is exposed through a
/// `public(package)` getter. Every module aborts with these getters, giving a
/// single globally-unique numbering — a failed tx's code names the failure.
module fullmetal::errors;

// --- binding / auth (0–9) ---
const EWrongInstitution: u64 = 0; // cap.institution_id != this institution
const EAdminRevoked: u64 = 1; // AdminCap not in live_admin_caps
const ECapRevoked: u64 = 2; // TraderCap not live / stale epoch / cap_id mismatch
const ENotActive: u64 = 3; // trader marked inactive
const ENotProposedAdmin: u64 = 4; // accept_admin_transfer by wrong address
const EAdminTransferPending: u64 = 5; // propose while a transfer is already pending

// --- governance invariants (10–19) ---
const ECannotRemoveLastAdmin: u64 = 10; // admin_count would drop to 0
const EAlreadyPaused: u64 = 11;
const ENotPaused: u64 = 12;
const EPaused: u64 = 13; // value-moving call while paused

// --- treasury (20–29) ---
const EZeroAmount: u64 = 20;
const EWouldUnderfundReserved: u64 = 21; // withdraw > available (breaks total >= reserved)
const EInsufficientTreasury: u64 = 22; // reserve/settlement exceeds available
const EInsufficientLiquidity: u64 = 23; // economically free but physically rehypothecated; recall first
const EBelowLiquidityFloor: u64 = 24; // deploy would leave liquid treasury under the risk floor F

// --- traders / limits (30–39) ---
const ETraderExists: u64 = 30;
const ENoSuchTrader: u64 = 31;
const EOverBookSize: u64 = 32; // deployed + amount > book_size
const ECannotShrinkBelowDeployed: u64 = 33;

// --- registry (40–49) ---
const EHandleTaken: u64 = 40;
const EHandleInvalid: u64 = 41; // charset / length

// --- OTC + settlement seams (50–59) ---
const EWitnessNotAllowed: u64 = 50; // OTC witness type not allowlisted / mismatched
const ETicketMismatch: u64 = 51; // settlement payee != ticket.to_inst
const EContractExists: u64 = 52; // otc_id already registered
const ENoContract: u64 = 53; // otc_id not registered or already closed
const ERecallTooLarge: u64 = 54; // release/recall exceeds reserved/deployed/rehypothecated

// --- oracle (60–69) ---
const EFeedExists: u64 = 60;
const ENoFeed: u64 = 61;
const EZeroPrice: u64 = 62;
const ETriggerNotActive: u64 = 63; // risk-responsive recall attempted while no trigger is active

// --- otc forward (70–89) ---
const ENotCounterparties: u64 = 70; // the two institutions are the same / mismatched
const EContractNotActive: u64 = 71;
const ENotDueYet: u64 = 72; // settlement interval has not elapsed
const EHealthy: u64 = 73; // liquidation attempted on a healthy position
const ENotExpired: u64 = 74;
const EWrongOracleFeed: u64 = 75; // oracle symbol does not match the contract underlying
const EZeroNotional: u64 = 76;
const ECureWindowActive: u64 = 77; // liquidation attempted before the margin-call cure window elapsed

// --- rfq (90–109) ---
const ERfqNotOpen: u64 = 90;
const ERfqExpired: u64 = 91;
const ENotTargeted: u64 = 92;
const EQuoteNotLive: u64 = 93;
const EQuoteExpired: u64 = 94;
const EQuoteNotExpired: u64 = 95;
const EQuoteRfqMismatch: u64 = 96;
const EWrongMakerInst: u64 = 97;
const ENotRequester: u64 = 99;
const EPriceOutOfBand: u64 = 100;
const EQuoteOutlivesRfq: u64 = 101;
const ENotQuoteOwner: u64 = 102;
const EBadParams: u64 = 103;
const EReservationMismatch: u64 = 104; // rekey magnitudes != expected
const ECrossedQuote: u64 = 105; // two-way quote with bid > ask
const EAlreadyQuoted: u64 = 106; // maker already used its single shot on this RFQ
const EOverBucket: u64 = 107; // accept notional exceeds the RFQ's bucket ceiling

// --- direct offer (110–119) ---
const EOfferNotLive: u64 = 110;
const EOfferExpired: u64 = 111;
const EOfferNotExpired: u64 = 112;
const ENotCounterparty: u64 = 113; // accept by an institution other than the named counterparty
const ENotProposer: u64 = 114; // withdraw by a trader other than the proposer
const EWrongProposerInst: u64 = 115; // proposer Institution arg != offer.proposer_inst

public(package) fun e_wrong_institution(): u64 { EWrongInstitution }
public(package) fun e_admin_revoked(): u64 { EAdminRevoked }
public(package) fun e_cap_revoked(): u64 { ECapRevoked }
public(package) fun e_not_active(): u64 { ENotActive }
public(package) fun e_not_proposed_admin(): u64 { ENotProposedAdmin }
public(package) fun e_admin_transfer_pending(): u64 { EAdminTransferPending }
public(package) fun e_cannot_remove_last_admin(): u64 { ECannotRemoveLastAdmin }
public(package) fun e_already_paused(): u64 { EAlreadyPaused }
public(package) fun e_not_paused(): u64 { ENotPaused }
public(package) fun e_paused(): u64 { EPaused }
public(package) fun e_zero_amount(): u64 { EZeroAmount }
public(package) fun e_would_underfund_reserved(): u64 { EWouldUnderfundReserved }
public(package) fun e_insufficient_treasury(): u64 { EInsufficientTreasury }
public(package) fun e_insufficient_liquidity(): u64 { EInsufficientLiquidity }
public(package) fun e_below_liquidity_floor(): u64 { EBelowLiquidityFloor }
public(package) fun e_trader_exists(): u64 { ETraderExists }
public(package) fun e_no_such_trader(): u64 { ENoSuchTrader }
public(package) fun e_over_book_size(): u64 { EOverBookSize }
public(package) fun e_cannot_shrink_below_deployed(): u64 { ECannotShrinkBelowDeployed }
public(package) fun e_handle_taken(): u64 { EHandleTaken }
public(package) fun e_handle_invalid(): u64 { EHandleInvalid }
public(package) fun e_witness_not_allowed(): u64 { EWitnessNotAllowed }
public(package) fun e_ticket_mismatch(): u64 { ETicketMismatch }
public(package) fun e_contract_exists(): u64 { EContractExists }
public(package) fun e_no_contract(): u64 { ENoContract }
public(package) fun e_recall_too_large(): u64 { ERecallTooLarge }
public(package) fun e_feed_exists(): u64 { EFeedExists }
public(package) fun e_no_feed(): u64 { ENoFeed }
public(package) fun e_zero_price(): u64 { EZeroPrice }
public(package) fun e_trigger_not_active(): u64 { ETriggerNotActive }
public(package) fun e_not_counterparties(): u64 { ENotCounterparties }
public(package) fun e_contract_not_active(): u64 { EContractNotActive }
public(package) fun e_not_due_yet(): u64 { ENotDueYet }
public(package) fun e_healthy(): u64 { EHealthy }
public(package) fun e_not_expired(): u64 { ENotExpired }
public(package) fun e_wrong_oracle_feed(): u64 { EWrongOracleFeed }
public(package) fun e_zero_notional(): u64 { EZeroNotional }
public(package) fun e_cure_window_active(): u64 { ECureWindowActive }
public(package) fun e_rfq_not_open(): u64 { ERfqNotOpen }
public(package) fun e_rfq_expired(): u64 { ERfqExpired }
public(package) fun e_not_targeted(): u64 { ENotTargeted }
public(package) fun e_quote_not_live(): u64 { EQuoteNotLive }
public(package) fun e_quote_expired(): u64 { EQuoteExpired }
public(package) fun e_quote_not_expired(): u64 { EQuoteNotExpired }
public(package) fun e_quote_rfq_mismatch(): u64 { EQuoteRfqMismatch }
public(package) fun e_wrong_maker_inst(): u64 { EWrongMakerInst }
public(package) fun e_not_requester(): u64 { ENotRequester }
public(package) fun e_price_out_of_band(): u64 { EPriceOutOfBand }
public(package) fun e_quote_outlives_rfq(): u64 { EQuoteOutlivesRfq }
public(package) fun e_not_quote_owner(): u64 { ENotQuoteOwner }
public(package) fun e_bad_params(): u64 { EBadParams }
public(package) fun e_reservation_mismatch(): u64 { EReservationMismatch }
public(package) fun e_crossed_quote(): u64 { ECrossedQuote }
public(package) fun e_already_quoted(): u64 { EAlreadyQuoted }
public(package) fun e_over_bucket(): u64 { EOverBucket }
public(package) fun e_offer_not_live(): u64 { EOfferNotLive }
public(package) fun e_offer_expired(): u64 { EOfferExpired }
public(package) fun e_offer_not_expired(): u64 { EOfferNotExpired }
public(package) fun e_not_counterparty(): u64 { ENotCounterparty }
public(package) fun e_not_proposer(): u64 { ENotProposer }
public(package) fun e_wrong_proposer_inst(): u64 { EWrongProposerInst }

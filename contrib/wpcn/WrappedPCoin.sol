// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title Wrapped PCoin (wPCN) -- a fixed-supply BEP-20 claim on locked PCN.
///
/// WHAT THIS IS, AND WHAT IT IS NOT.
///
/// wPCN is NOT PCoin. PCoin is an independent Layer-1 with its own chain; this
/// is a token on BNB Smart Chain that represents a claim on PCN held in a
/// publicly named reserve address. It exists for one reason: on PCoin's own
/// chain, acquiring PCN requires finding a counterparty. Here it requires a
/// wallet and a click.
///
/// THE DESIGN IS DELIBERATELY BORING, AND EVERY OMISSION IS THE POINT.
///
/// There is no owner. There is no mint function. There is no pause, no
/// blacklist, no transfer fee, no rebase, no upgrade proxy, no
/// `setTaxWallet`. The entire supply is created once, in the constructor, and
/// after deployment nobody -- including whoever deployed it -- can create
/// another unit. That is checkable in the bytecode rather than promised in a
/// document, and it is the single most important property of this contract.
///
/// The reason it matters here specifically: PCoin's hashrate is concentrated,
/// and a bridge that accepted public PCN deposits would be exactly the shape a
/// majority miner monetises -- deposit, mint, sell, then reorg the deposit
/// away. This contract has no deposit path at all. Nothing can be deposited,
/// so nothing can be reorged out from under it. That is not a mitigation; it is
/// the absence of the attack surface.
///
/// WHAT YOU STILL HAVE TO TRUST.
///
/// One thing, and it is not enforced by this code: that the reserve address
/// really holds the PCN backing this supply, and that redemption requests are
/// honoured. The reserve address is written into this contract at deployment
/// and emitted in `Deployed`, so anyone can check the balance themselves on
/// any PCoin explorer at any time. But no smart contract can reach across to
/// another chain and prove it. Treat wPCN as an issued claim, not as trustless
/// wrapped value, and price that in.
///
/// REDEMPTION.
///
/// `redeem` burns your tokens and emits your PCoin address in an event. That is
/// a permanent, timestamped, on-chain record of the request that the issuer
/// cannot alter or deny -- which is the strongest thing a single-chain contract
/// can do for you. Settlement itself is manual: somebody sends the PCN. Burning
/// first is required by construction, so understand the order before you call
/// it: your tokens are gone the moment the transaction confirms, and what you
/// hold afterwards is the event log and the issuer's word.
contract WrappedPCoin {
    string public constant name = "Wrapped PCoin";
    string public constant symbol = "wPCN";

    /// @dev 8, matching PCoin's own smallest unit exactly, so 1 wPCN is 1 PCN
    ///      with no scaling factor anywhere. This follows WBTC, which likewise
    ///      keeps its origin chain's 8 decimals rather than the 18 that is
    ///      conventional for tokens native to EVM chains. A conversion factor
    ///      between a wrapper and its backing is a rounding bug waiting for
    ///      somebody to find it.
    uint8 public constant decimals = 8;

    /// @notice Circulating supply. Decrements when tokens are redeemed, which is
    ///         what every wallet, explorer and aggregator expects of this field.
    uint256 public totalSupply;

    /// @notice The supply created at deployment, and therefore the number the
    ///         reserve was sized against. Never changes.
    /// @dev Kept separate from `totalSupply` on purpose. The reserve backs what
    ///      was ISSUED; `totalSupply` tracks what is still OUTSTANDING. Folding
    ///      both meanings into one standard field would have made this contract
    ///      quietly non-conformant, and a wrapper nobody can reason about is
    ///      worse than one with an extra getter.
    uint256 public immutable issuedSupply;

    /// @notice The PCoin address holding the PCN that backs this entire supply.
    /// @dev Immutable and emitted at deployment. If this ever needs to change,
    ///      the honest move is a new token, not a setter -- a mutable reserve
    ///      pointer is indistinguishable from no reserve at all.
    string public reserveAddress;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    /// @notice Emitted once, at deployment, recording the backing claim.
    event Deployed(uint256 supply, string reserveAddress);

    /// @notice A redemption request. `pcoinAddress` is where the holder wants
    ///         the underlying PCN sent. Settlement is off-chain and manual.
    event Redeem(address indexed from, uint256 value, string pcoinAddress);

    /// @param supply_ Total units, in satoshi-equivalents (8 decimals). Must be
    ///        matched by PCN actually locked in `reserveAddress_` before this is
    ///        deployed, not after.
    /// @param reserveAddress_ The PCoin address holding the backing.
    constructor(uint256 supply_, string memory reserveAddress_) {
        require(supply_ > 0, "supply must be non-zero");
        // 21,000,000 PCN at 8 decimals -- PCoin's consensus cap. A wrapper that
        // could represent more units than the origin chain will ever mint is
        // self-evidently unbacked, so refuse it in code rather than in a README.
        require(supply_ <= 21_000_000 * 10 ** 8, "supply exceeds PCoin's 21M cap");
        require(bytes(reserveAddress_).length > 0, "reserve address required");

        totalSupply = supply_;
        issuedSupply = supply_;
        reserveAddress = reserveAddress_;

        // The whole supply goes to the deployer, once. There is no other
        // creation path in this contract.
        balanceOf[msg.sender] = supply_;
        emit Transfer(address(0), msg.sender, supply_);
        emit Deployed(supply_, reserveAddress_);
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        // An unlimited allowance is left untouched rather than decremented.
        // PancakeSwap's router asks for max approval and this saves a storage
        // write on every single swap that routes through the pool.
        if (allowed != type(uint256).max) {
            require(allowed >= value, "insufficient allowance");
            allowance[from][msg.sender] = allowed - value;
        }
        _transfer(from, to, value);
        return true;
    }

    /// @notice Burn `value` tokens and record a request to receive the
    ///         underlying PCN at `pcoinAddress`.
    /// @dev The tokens are destroyed immediately and irreversibly. Settlement is
    ///      manual and off-chain; this function's product is the event, which no
    ///      one can retract.
    function redeem(uint256 value, string calldata pcoinAddress) external {
        require(bytes(pcoinAddress).length > 0, "pcoin address required");
        // Bounded so a fat-fingered paste cannot write unbounded calldata into
        // the log. PCoin addresses are bech32 "pc1..." (42 chars) or base58
        // (34 chars); 90 leaves generous room without being a free text field.
        require(bytes(pcoinAddress).length <= 90, "pcoin address too long");

        uint256 balance = balanceOf[msg.sender];
        require(balance >= value, "insufficient balance");
        require(value > 0, "nothing to redeem");

        balanceOf[msg.sender] = balance - value;
        // Standard burn semantics: outstanding supply falls. `issuedSupply`
        // still records what the reserve was sized against, so the backing
        // ratio remains checkable without overloading a standard field.
        totalSupply -= value;
        emit Transfer(msg.sender, address(0), value);
        emit Redeem(msg.sender, value, pcoinAddress);
    }

    function _transfer(address from, address to, uint256 value) private {
        // Sending to address(0) via transfer is almost always a mistake rather
        // than an intentional burn. Burning has its own named function, which
        // also records where the PCN should go.
        require(to != address(0), "transfer to the zero address");
        uint256 balance = balanceOf[from];
        require(balance >= value, "insufficient balance");
        balanceOf[from] = balance - value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }
}

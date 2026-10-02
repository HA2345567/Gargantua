use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    ed25519_program,
    hash::hashv,
    sysvar::instructions::{load_current_index_checked, load_instruction_at_checked},
};
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount, TransferChecked};

declare_id!("Fg6PaFpoGXkYsidMpWxTWqkZ6W2BeZ7FEfcYkgMQhg5");

const CONFIG_SEED: &[u8] = b"config";
const PARLAY_SEED: &[u8] = b"parlay";
const QUOTE_DOMAIN: &[u8] = b"GARGANTUA_PARLAY_QUOTE_V1";
const MAX_SETTLEMENT_SIGNERS: usize = 5;

#[program]
pub mod gargantua_escrow {
    use super::*;

    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        quote_signer: Pubkey,
        settlement_signers: Vec<Pubkey>,
        settlement_threshold: u8,
    ) -> Result<()> {
        require!(quote_signer != Pubkey::default(), EscrowError::InvalidConfiguration);
        require!(
            !settlement_signers.is_empty() && settlement_signers.len() <= MAX_SETTLEMENT_SIGNERS,
            EscrowError::InvalidConfiguration
        );
        require!(
            settlement_threshold > 0 && usize::from(settlement_threshold) <= settlement_signers.len(),
            EscrowError::InvalidConfiguration
        );
        for (index, key) in settlement_signers.iter().enumerate() {
            require!(*key != Pubkey::default(), EscrowError::InvalidConfiguration);
            require!(!settlement_signers[..index].contains(key), EscrowError::InvalidConfiguration);
        }

        let config = &mut ctx.accounts.config;
        config.authority = ctx.accounts.authority.key();
        config.mint = ctx.accounts.mint.key();
        config.quote_signer = quote_signer;
        config.settlement_signers = settlement_signers;
        config.settlement_threshold = settlement_threshold;
        config.bump = ctx.bumps.config;
        Ok(())
    }

    /// Accept a 2–5 leg parlay quote signed by the configured quote service.
    /// The user's transaction transfers test-token stake into a per-parlay PDA vault.
    pub fn accept_parlay(
        ctx: Context<AcceptParlay>,
        nonce: [u8; 32],
        stake: u64,
        max_payout: u64,
        expires_at: i64,
        legs_hash: [u8; 32],
    ) -> Result<()> {
        require!(stake > 0 && max_payout >= stake, EscrowError::InvalidQuote);
        require!(expires_at > Clock::get()?.unix_timestamp, EscrowError::QuoteExpired);
        require_keys_eq!(ctx.accounts.mint.key(), ctx.accounts.config.mint, EscrowError::WrongMint);

        let digest = quote_digest(
            ctx.program_id,
            &ctx.accounts.config,
            &ctx.accounts.user.key(),
            &nonce,
            stake,
            max_payout,
            expires_at,
            &legs_hash,
        );
        verify_preceding_ed25519(
            &ctx.accounts.instructions,
            ctx.accounts.config.quote_signer,
            &digest,
        )?;

        let parlay = &mut ctx.accounts.parlay;
        parlay.owner = ctx.accounts.user.key();
        parlay.mint = ctx.accounts.mint.key();
        parlay.nonce = nonce;
        parlay.stake = stake;
        parlay.max_payout = max_payout;
        parlay.expires_at = expires_at;
        parlay.legs_hash = legs_hash;
        parlay.quote_digest = digest;
        parlay.status = ParlayStatus::Open;
        parlay.payout = 0;
        parlay.settled_at = None;
        parlay.bump = ctx.bumps.parlay;

        token::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.owner_tokens.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.parlay_vault.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            stake,
            ctx.accounts.mint.decimals,
        )?;
        Ok(())
    }

    /// result: 0 = lost, 1 = won, 2 = void. payout is gross token base units.
    pub fn settle_parlay(ctx: Context<SettleParlay>, result: u8, payout: u64) -> Result<()> {
        require!(ctx.accounts.parlay.status == ParlayStatus::Open, EscrowError::AlreadySettled);
        require!(result <= 2, EscrowError::InvalidSettlement);
        require!(payout <= ctx.accounts.parlay.max_payout, EscrowError::PayoutTooLarge);
        verify_settlement_threshold(&ctx.accounts.config, ctx.remaining_accounts)?;

        let stake = ctx.accounts.parlay.stake;
        match result {
            0 => require!(payout == 0, EscrowError::InvalidSettlement),
            1 => require!(payout > 0, EscrowError::InvalidSettlement),
            2 => require!(payout == stake, EscrowError::InvalidSettlement),
            _ => return err!(EscrowError::InvalidSettlement),
        }
        require!(ctx.accounts.parlay_vault.amount >= stake, EscrowError::VaultInvariant);

        let bump = [ctx.accounts.parlay.bump];
        let owner_key = ctx.accounts.parlay.owner;
        let nonce = ctx.accounts.parlay.nonce;
        let parlay_seeds: &[&[u8]] = &[
            PARLAY_SEED,
            owner_key.as_ref(),
            nonce.as_ref(),
            &bump,
        ];
        let parlay_signer = &[parlay_seeds];
        let parlay_authority = ctx.accounts.parlay.to_account_info();

        if result == 0 {
            transfer_from_parlay(
                &ctx.accounts.token_program,
                &ctx.accounts.parlay_vault,
                &ctx.accounts.mint,
                &ctx.accounts.house_vault,
                &parlay_authority,
                parlay_signer,
                stake,
            )?;
        } else {
            let from_escrow = payout.min(stake);
            if from_escrow > 0 {
                transfer_from_parlay(
                    &ctx.accounts.token_program,
                    &ctx.accounts.parlay_vault,
                    &ctx.accounts.mint,
                    &ctx.accounts.owner_tokens,
                    &parlay_authority,
                    parlay_signer,
                    from_escrow,
                )?;
            }
            let house_top_up = payout.saturating_sub(stake);
            if house_top_up > 0 {
                require!(ctx.accounts.house_vault.amount >= house_top_up, EscrowError::InsufficientHouseLiquidity);
                let config_bump = [ctx.accounts.config.bump];
                let config_seeds: &[&[u8]] = &[CONFIG_SEED, &config_bump];
                token::transfer_checked(
                    CpiContext::new_with_signer(
                        ctx.accounts.token_program.to_account_info(),
                        TransferChecked {
                            from: ctx.accounts.house_vault.to_account_info(),
                            mint: ctx.accounts.mint.to_account_info(),
                            to: ctx.accounts.owner_tokens.to_account_info(),
                            authority: ctx.accounts.config.to_account_info(),
                        },
                        &[config_seeds],
                    ),
                    house_top_up,
                    ctx.accounts.mint.decimals,
                )?;
            }
            let house_remainder = stake.saturating_sub(payout);
            if house_remainder > 0 {
                transfer_from_parlay(
                    &ctx.accounts.token_program,
                    &ctx.accounts.parlay_vault,
                    &ctx.accounts.mint,
                    &ctx.accounts.house_vault,
                    &parlay_authority,
                    parlay_signer,
                    house_remainder,
                )?;
            }
        }

        ctx.accounts.parlay.status = match result {
            0 => ParlayStatus::Lost,
            1 => ParlayStatus::Won,
            _ => ParlayStatus::Void,
        };
        ctx.accounts.parlay.payout = payout;
        ctx.accounts.parlay.settled_at = Some(Clock::get()?.unix_timestamp);

        token::close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            CloseAccount {
                account: ctx.accounts.parlay_vault.to_account_info(),
                destination: ctx.accounts.owner.to_account_info(),
            authority: parlay_authority,
            },
            parlay_signer,
        ))?;
        Ok(())
    }
}

fn transfer_from_parlay<'info>(
    token_program: &Program<'info, Token>,
    from: &Account<'info, TokenAccount>,
    mint: &Account<'info, Mint>,
    to: &Account<'info, TokenAccount>,
    authority: &AccountInfo<'info>,
    signer: &[&[&[u8]]],
    amount: u64,
) -> Result<()> {
    token::transfer_checked(
        CpiContext::new_with_signer(
            token_program.to_account_info(),
            TransferChecked {
                from: from.to_account_info(),
                mint: mint.to_account_info(),
                to: to.to_account_info(),
                authority: authority.clone(),
            },
            signer,
        ),
        amount,
        mint.decimals,
    )
}

fn quote_digest(
    program_id: &Pubkey,
    config: &Config,
    owner: &Pubkey,
    nonce: &[u8; 32],
    stake: u64,
    max_payout: u64,
    expires_at: i64,
    legs_hash: &[u8; 32],
) -> [u8; 32] {
    let stake_bytes = stake.to_le_bytes();
    let payout_bytes = max_payout.to_le_bytes();
    let expiry_bytes = expires_at.to_le_bytes();
    hashv(&[
        QUOTE_DOMAIN,
        program_id.as_ref(),
        config.mint.as_ref(),
        owner.as_ref(),
        nonce,
        &stake_bytes,
        &payout_bytes,
        &expiry_bytes,
        legs_hash,
    ])
    .to_bytes()
}

fn verify_preceding_ed25519(
    instructions_sysvar: &AccountInfo,
    expected_key: Pubkey,
    expected_message: &[u8; 32],
) -> Result<()> {
    let current = load_current_index_checked(instructions_sysvar)? as usize;
    require!(current > 0, EscrowError::MissingQuoteSignature);
    let instruction = load_instruction_at_checked(current - 1, instructions_sysvar)?;
    require_keys_eq!(instruction.program_id, ed25519_program::id(), EscrowError::MissingQuoteSignature);
    let data = instruction.data;
    require!(data.len() >= 16 && data[0] == 1, EscrowError::InvalidQuoteSignature);
    let read_u16 = |offset: usize| -> Result<u16> {
        let bytes = data.get(offset..offset + 2).ok_or(EscrowError::InvalidQuoteSignature)?;
        Ok(u16::from_le_bytes([bytes[0], bytes[1]]))
    };
    let signature_offset = usize::from(read_u16(2)?);
    let signature_instruction = read_u16(4)?;
    let public_key_offset = usize::from(read_u16(6)?);
    let public_key_instruction = read_u16(8)?;
    let message_offset = usize::from(read_u16(10)?);
    let message_size = usize::from(read_u16(12)?);
    let message_instruction = read_u16(14)?;
    require!(
        signature_instruction == u16::MAX
            && public_key_instruction == u16::MAX
            && message_instruction == u16::MAX
            && message_size == 32,
        EscrowError::InvalidQuoteSignature
    );
    let signature_end = signature_offset.checked_add(64).ok_or(EscrowError::InvalidQuoteSignature)?;
    let public_key_end = public_key_offset.checked_add(32).ok_or(EscrowError::InvalidQuoteSignature)?;
    let message_end = message_offset.checked_add(32).ok_or(EscrowError::InvalidQuoteSignature)?;
    require!(signature_end <= data.len() && public_key_end <= data.len() && message_end <= data.len(), EscrowError::InvalidQuoteSignature);
    require!(data[public_key_offset..public_key_end] == expected_key.to_bytes(), EscrowError::InvalidQuoteSignature);
    require!(data[message_offset..message_end] == expected_message[..], EscrowError::InvalidQuoteSignature);
    // The preceding ed25519 precompile has already verified the signature bytes.
    Ok(())
}

fn verify_settlement_threshold(config: &Config, accounts: &[AccountInfo]) -> Result<()> {
    let mut approved: Vec<Pubkey> = Vec::new();
    for account in accounts {
        if account.is_signer && config.settlement_signers.contains(account.key) && !approved.contains(account.key) {
            approved.push(*account.key);
        }
    }
    require!(approved.len() >= usize::from(config.settlement_threshold), EscrowError::InsufficientSettlementApprovals);
    Ok(())
}

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(init, payer = authority, space = 8 + Config::MAX_SIZE, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    pub mint: Account<'info, Mint>,
    #[account(init, payer = authority, associated_token::mint = mint, associated_token::authority = config)]
    pub house_vault: Account<'info, TokenAccount>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(nonce: [u8; 32], stake: u64, max_payout: u64, expires_at: i64, legs_hash: [u8; 32])]
pub struct AcceptParlay<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(init, payer = user, space = 8 + Parlay::MAX_SIZE, seeds = [PARLAY_SEED, user.key().as_ref(), nonce.as_ref()], bump)]
    pub parlay: Account<'info, Parlay>,
    pub mint: Account<'info, Mint>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = user)]
    pub owner_tokens: Account<'info, TokenAccount>,
    #[account(init, payer = user, associated_token::mint = mint, associated_token::authority = parlay)]
    pub parlay_vault: Account<'info, TokenAccount>,
    /// CHECK: The instructions sysvar is address-constrained and its preceding ed25519 instruction is parsed.
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions: AccountInfo<'info>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SettleParlay<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, has_one = mint)]
    pub parlay: Account<'info, Parlay>,
    /// CHECK: The key equals the stored parlay owner; receives payout and reclaimed vault rent.
    #[account(mut, address = parlay.owner)]
    pub owner: AccountInfo<'info>,
    pub mint: Account<'info, Mint>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = owner)]
    pub owner_tokens: Account<'info, TokenAccount>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = parlay)]
    pub parlay_vault: Account<'info, TokenAccount>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = config)]
    pub house_vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[account]
pub struct Config {
    pub authority: Pubkey,
    pub mint: Pubkey,
    pub quote_signer: Pubkey,
    pub settlement_signers: Vec<Pubkey>,
    pub settlement_threshold: u8,
    pub bump: u8,
}

impl Config {
    pub const MAX_SIZE: usize = 32 + 32 + 32 + 4 + 32 * MAX_SETTLEMENT_SIGNERS + 1 + 1;
}

#[account]
pub struct Parlay {
    pub owner: Pubkey,
    pub mint: Pubkey,
    pub nonce: [u8; 32],
    pub stake: u64,
    pub max_payout: u64,
    pub expires_at: i64,
    pub legs_hash: [u8; 32],
    pub quote_digest: [u8; 32],
    pub status: ParlayStatus,
    pub payout: u64,
    pub settled_at: Option<i64>,
    pub bump: u8,
}

impl Parlay {
    pub const MAX_SIZE: usize = 32 + 32 + 32 + 8 + 8 + 8 + 32 + 32 + 1 + 8 + 1 + 8 + 1;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum ParlayStatus {
    Open,
    Won,
    Lost,
    Void,
}

#[error_code]
pub enum EscrowError {
    #[msg("configuration values are invalid")]
    InvalidConfiguration,
    #[msg("the quote is malformed")]
    InvalidQuote,
    #[msg("the signed quote has expired")]
    QuoteExpired,
    #[msg("the quote signature instruction is missing")]
    MissingQuoteSignature,
    #[msg("the quote signature instruction does not match the expected key and quote")]
    InvalidQuoteSignature,
    #[msg("the token mint is not the configured escrow mint")]
    WrongMint,
    #[msg("the parlay is already settled")]
    AlreadySettled,
    #[msg("the settlement result or payout is invalid")]
    InvalidSettlement,
    #[msg("the payout exceeds the signed quote cap")]
    PayoutTooLarge,
    #[msg("not enough configured settlement signers approved")]
    InsufficientSettlementApprovals,
    #[msg("the house vault lacks payout liquidity")]
    InsufficientHouseLiquidity,
    #[msg("escrow vault is below the recorded stake")]
    VaultInvariant,
}

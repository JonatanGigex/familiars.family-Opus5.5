import { Connection, PublicKey, VersionedTransaction, type ParsedAccountData } from '@solana/web3.js'

export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
export const LAMPORTS_PER_SOL = 1_000_000_000

export interface TokenBalance {
  mint: string
  account: string
  program: string
  amountRaw: bigint
  decimals: number
  uiAmount: number
}

export interface MintInfo {
  mint: string
  program: string
  decimals: number
  supplyRaw: bigint
  mintAuthority: string | null
  freezeAuthority: string | null
  extensions: { extension: string; state?: Record<string, unknown> }[]
}

/** Token-2022 extensions that let someone else take, freeze or tax our tokens. */
const DANGEROUS_EXTENSIONS = new Set([
  'transferHook',
  'permanentDelegate',
  'nonTransferable',
  'pausableConfig',
  'defaultAccountState',
  'confidentialTransferFeeConfig',
])

export function mintRisks(info: MintInfo): string[] {
  const risks: string[] = []
  if (info.mintAuthority) risks.push('mint authority active')
  if (info.freezeAuthority) risks.push('freeze authority active')
  for (const ext of info.extensions) {
    if (DANGEROUS_EXTENSIONS.has(ext.extension)) risks.push(`token-2022 ${ext.extension}`)
    if (ext.extension === 'transferFeeConfig') {
      const newer = (ext.state?.newerTransferFee as { transferFeeBasisPoints?: number } | undefined)?.transferFeeBasisPoints ?? 0
      const older = (ext.state?.olderTransferFee as { transferFeeBasisPoints?: number } | undefined)?.transferFeeBasisPoints ?? 0
      if (newer > 0 || older > 0) risks.push(`transfer fee ${Math.max(newer, older)} bps`)
      else if (ext.state?.transferFeeConfigAuthority) risks.push('transfer fee can be enabled')
    }
  }
  return risks
}

export class SolanaClient {
  readonly connection: Connection

  constructor(rpcUrl: string) {
    this.connection = new Connection(rpcUrl, { commitment: 'confirmed' })
  }

  async solBalanceLamports(owner: string): Promise<number> {
    return this.connection.getBalance(new PublicKey(owner), 'confirmed')
  }

  async tokenBalances(owner: string): Promise<TokenBalance[]> {
    const out: TokenBalance[] = []
    for (const program of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) {
      const res = await this.connection.getParsedTokenAccountsByOwner(new PublicKey(owner), { programId: new PublicKey(program) })
      for (const { pubkey, account } of res.value) {
        const info = (account.data as ParsedAccountData).parsed?.info
        const amount = info?.tokenAmount
        if (!info || !amount) continue
        out.push({
          mint: info.mint,
          account: pubkey.toBase58(),
          program,
          amountRaw: BigInt(amount.amount),
          decimals: amount.decimals,
          uiAmount: Number(amount.uiAmountString ?? amount.uiAmount ?? 0),
        })
      }
    }
    return out
  }

  async mintInfo(mint: string): Promise<MintInfo | null> {
    const res = await this.connection.getParsedAccountInfo(new PublicKey(mint))
    const acc = res.value
    if (!acc) return null
    const data = acc.data as ParsedAccountData
    const info = data.parsed?.info
    if (!info || data.parsed?.type !== 'mint') return null
    return {
      mint,
      program: acc.owner.toBase58(),
      decimals: info.decimals,
      supplyRaw: BigInt(info.supply),
      mintAuthority: info.mintAuthority ?? null,
      freezeAuthority: info.freezeAuthority ?? null,
      extensions: Array.isArray(info.extensions) ? info.extensions : [],
    }
  }

  /**
   * Simulates a (possibly partially signed) transaction and returns post-state
   * lamports / token amounts for the given accounts. Used to prove a swap only
   * moves what we asked it to move before we sign it.
   */
  async simulateBalances(
    tx: VersionedTransaction,
    wallet: string,
    tokenAccounts: string[],
  ): Promise<{ err: unknown; logs: string[]; lamports: number | null; tokenAmounts: Record<string, bigint | null> }> {
    const addresses = [wallet, ...tokenAccounts]
    const sim = await this.connection.simulateTransaction(tx, {
      sigVerify: false,
      replaceRecentBlockhash: false,
      commitment: 'confirmed',
      accounts: { encoding: 'base64', addresses },
    })
    const accounts = sim.value.accounts ?? []
    const walletAcc = accounts[0]
    const tokenAmounts: Record<string, bigint | null> = {}
    tokenAccounts.forEach((addr, i) => {
      const acc = accounts[i + 1]
      const b64 = acc?.data?.[0]
      if (!acc || !b64) {
        tokenAmounts[addr] = null
        return
      }
      const buf = Buffer.from(b64, 'base64')
      tokenAmounts[addr] = buf.length >= 72 ? buf.readBigUInt64LE(64) : null
    })
    return { err: sim.value.err, logs: sim.value.logs ?? [], lamports: walletAcc ? walletAcc.lamports : null, tokenAmounts }
  }
}

export function associatedTokenAddress(owner: string, mint: string, program: string): string {
  const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
  const [addr] = PublicKey.findProgramAddressSync(
    [new PublicKey(owner).toBuffer(), new PublicKey(program).toBuffer(), new PublicKey(mint).toBuffer()],
    ATA_PROGRAM,
  )
  return addr.toBase58()
}

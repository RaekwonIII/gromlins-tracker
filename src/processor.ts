import {lookupArchive} from "@subsquid/archive-registry"
import * as ss58 from "@subsquid/ss58"
import {BatchContext, BatchProcessorItem, EvmLogEvent, SubstrateBatchProcessor, SubstrateBlock} from "@subsquid/substrate-processor"
import {Store, TypeormDatabase} from "@subsquid/typeorm-store"
import {In} from "typeorm"
import {Contract, Owner, Token, Transfer} from "./model"
import { events, functions } from "./abi/gromlins"
import { Multicall } from "./abi/multicall";
import { maxBy } from 'lodash';
import { BigNumber, ethers } from "ethers"

const contractAddress = "0xF27A6C72398eb7E25543d19fda370b7083474735";
// https://docs.moonbeam.network/builders/build/canonical-contracts/
const MULTICALL_ADDRESS = "0x83e3b61886770de2F64AAcaD2724ED4f08F7f36B";

const processor = new SubstrateBatchProcessor()
    .setBlockRange({ from: 1777560 })
    .setDataSource({
        // Lookup archive by the network name in the Subsquid registry
        archive: lookupArchive("moonbeam", {release: "FireSquid"}),
        chain: "wss://moonbeam.api.onfinality.io/public-ws"
    })
    .addEvmLog(contractAddress, {
        filter: [events.Transfer.topic],
    });


type Item = BatchProcessorItem<typeof processor>
type Ctx = BatchContext<Store, Item>


processor.run(new TypeormDatabase(), async ctx => {

    const transferData: TransferData[] = [];
    for (const block of ctx.blocks) {
        for (const item of block.items) {
            if (item.name === "EVM.Log") {
                const transfer = handleTransfer(ctx, block.header, item.event);
                transferData.push(transfer);
            }
        }
    }

    await saveTransfers(ctx, transferData);
})

type TransferData = {
    id: string;
    from: string;
    to: string;
    token: ethers.BigNumber;
    timestamp: bigint;
    block: number;
    transactionHash: string;
};

function handleTransfer(
    ctx: Ctx,
    block: SubstrateBlock,
    event: EvmLogEvent,
): TransferData {

    const evmLog = ((event.args.log || event.args));
    const {from, to, tokenId} = events.Transfer.decode(evmLog);

    const transfer = {
        id: event.id,
        token: tokenId,
        from,
        to,
        timestamp: BigInt(block.timestamp),
        block: block.height,
        transactionHash: event.evmTxHash,
    }

    return transfer;
};

async function saveTransfers(ctx: Ctx, transferData: TransferData[]) {
    const tokenIds: Set<string> = new Set();
    const ownerIds: Set<string> = new Set();

    for (const td of transferData) {
        tokenIds.add(td.token.toString());
        ownerIds.add(td.from);
        ownerIds.add(td.to);
    }

    const tokens: Map<string, Token> = new Map(
        (await ctx.store.findBy(Token, { id: In([...tokenIds]) })).map((token) => [token.id, token])
    );

    const owners: Map<string, Owner> = new Map(
        (await ctx.store.findBy(Owner, { id: In([...ownerIds]) })).map((owner) => [owner.id, owner])
    );

    let contractEntity = await ctx.store.get(Contract, contractAddress);
    if (contractEntity == null) {
        contractEntity = new Contract({
            id: contractAddress,
            name: "Gromlins",
            symbol: "GROMLIN",
            totalSupply: 3333n,
        })
        await ctx.store.insert(contractEntity);
    }

    const transfers: Set<Transfer> = new Set();
    for (const td of transferData) {

        let from = owners.get(td.from);
        if (from == null) {
            from = new Owner({ id: td.from});
            owners.set(from.id, from);
        }

        let to = owners.get(td.to);
        if (to == null) {
            to = new Owner({id: td.to});
            owners.set(to.id, to);
        }

        const tokenId = td.token.toString();

        let token = tokens.get(tokenId);
        if (token == null) {
            token = new Token({
                id: tokenId,
                // uri: using multicall to set this
                contract: contractEntity,
            });
            tokens.set(token.id, token);
        }
        token.owner = to;

        const transfer  = new Transfer({
            id: td.id,
            block: td.block,
            timestamp: td.timestamp,
            transactionHash: td.transactionHash,
            from: from,
            to: to,
            token: token
        });

        transfers.add(transfer);
    }


    const maxHeight = maxBy(transferData, t => t.block)!.block; 
    // query the multicall contract at the max height of the chunk
    const multicall = new Multicall(ctx, {height: maxHeight}, MULTICALL_ADDRESS)

    ctx.log.info(`Calling mutlicall for ${transferData.length} tokens...`)
    // call in pages of size 100
    const results = await multicall.tryAggregate(functions.tokenURI, transferData.map(t => [contractAddress, [t.token]] as [string, any[]]), 100);

    results.forEach((res, i) => {
        let t = tokens.get(transferData[i].token.toString());
        if (t) {
            let uri = '';
            if (res.success) {
                uri = <string>res.value;
            } else if (res.returnData) {
                uri = <string>functions.tokenURI.tryDecodeResult(res.returnData) || '';
            }
            t.uri = uri;
        }
    });
    ctx.log.info(`Done`);
    

    await ctx.store.save([...owners.values()]);
    await ctx.store.save([...tokens.values()]);
    await ctx.store.save([...transfers]);
}

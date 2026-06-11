# fullmetal-sui-demo
 Time to build the product and architecture for fullmetal (Institutional OTC derivatives with cross-margined risk-responsive collateral rehypothecation) for the sui overflow hackathon mvp. The goal of the product is to serve large institutions participating in bilateral derivative trades and use the blockchain to create a capital efficient collateral management which rehypothecates collateral to interest avenues (deepbook margin pool for this demo) and dynamically withdraws collateral rehypothecated when certain volatility or market triggers are activated. Traditionally large sums of collateral remain idle and there are many intermediaries managing the collateral, taking more fees for themselves and huge administrative complexity while instution posting the collateral earns no interest on it. 
 
 Use the Sui MCP to find sui related info.
 First iteration will be focusing on the risk responsive collateral rehypothecation to deepbook's margin pool. We settle in usdc for the otc derivatives. 
 
 What we want to do is discuss the object types, general code structure etc for this basic flow. 

 We are building a mono repo.

 We will need -
 1. An instutional wallet - which im guessing should be a smart contract multisig or something on those lines with admins and trader permissions. Please check this esepcially for "access" library. 
 https://mystenlabs.notion.site/OpenZeppelin-s-audited-Move-Libraries-and-Tools-36d6d9dcb4e980539272ded72c2856f6
 
 2. Then the otc contract itself - the choice can be between perpetuals, forward (time commitment lock in between two parties), or hybrid (commitment lock in and into flexible perpetual), the funding rate for perps and hybrid will probably require some special math/formula for bilateral party calculation so as of the first iteration we just keep it a fixed number. The instution chooses underlying asset, notional size, entry, collateral asset (usdc for now). Counterparty can either be known or RFQ can be used.

 Each instution will have its "margin account". Note that FULL margin is dynamically rehypothecated and tracked not partial so make sure you look into how accounting must be done in sui across the derivative margin requirement that is changing and also the margin amount in deepbook margin pool.   
 
 I want you to note that i want a cross margin design to be possible although but first build aim right now is to get the rehypothecation pieces connected end to end. 
 
 Initial margin is sent by the instutions when the contract is opened. 
 Variation margin is sent by losing institution to winning instution everyday based mark to market. It will get stored in the margin account (and rehypothecated. note rehypothecation interest is for the winning instution always) but the excess variation margin can be withdrawn any time.
 Maintence margin is a protocol number below initial margin where we liquidate and close position (70 percent of initial margin). 
 
3. risk-responsive rehypothecation contracts - we can have one trigger to test. 
Please check if it is possible with using deepbook sandbox
https://github.com/MystenLabs/deepbook-sandbox

Openzeppelin move libraries will probably be needed for the math
 https://mystenlabs.notion.site/OpenZeppelin-s-audited-Move-Libraries-and-Tools-36d6d9dcb4e980539272ded72c2856f6


4. nextjs frontend 
this should be a very simple demo . You can refer to fullmetal-web in the same directory as fullmetal-sui-demo for the styling

I plan to host on vercel at demo.fullmetal.finance

What i need to build is an RFQ system to get quotes from other instutions 

and please take a look at this typescript
https://sdk.mystenlabs.com/sui
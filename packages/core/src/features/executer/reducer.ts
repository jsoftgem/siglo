import { toPOJO } from "../context";
export class Reducer {
    private array: any[];
    private param: any;
    private chain: any;
    private Context: any;
    private propertyToContext: any;
    private context: any;
    private stackId?: string;

    constructor(
        array: any[],
        param: any,
        chain: any,
        Context: any,
        propertyToContext: (context: any, chainReturn: any) => void,
        contextInstance?: any,
        stackId?: string
    ) {
        this.array = array;
        this.param = param;
        this.chain = chain;
        this.Context = Context;
        this.propertyToContext = propertyToContext;
        this.stackId = stackId;
        this.context = contextInstance || Context.createContext(chain.$chainId, stackId);
    }

    reduce(done: (err?: any, accumulated?: any) => void, accumulated: any = {}, index = 0): void {
        setTimeout(() => {
            try {
                if (this.array && this.array.length > index) {
                    const currentValue = this.array[index];
                    const action = this.chain.action(Object.assign({}, this.param, accumulated), currentValue, index);
                    if (action !== undefined) {
                        if (action instanceof Promise) {
                            action.then(props => {
                                this.propertyToContext(this.context, props);
                                new Reducer(
                                    this.array,
                                    this.param,
                                    this.chain,
                                    this.Context,
                                    this.propertyToContext,
                                    this.context,
                                    this.stackId
                                ).reduce(done, toPOJO(this.context.getData()), ++index);
                            }).catch(err => done(err));
                        } else {
                            this.propertyToContext(this.context, action);
                            new Reducer(
                                this.array,
                                this.param,
                                this.chain,
                                this.Context,
                                this.propertyToContext,
                                this.context,
                                this.stackId
                            ).reduce(done, toPOJO(this.context.getData()), ++index);
                        }
                    } else {
                        new Reducer(
                            this.array,
                            this.param,
                            this.chain,
                            this.Context,
                            this.propertyToContext,
                            this.context,
                            this.stackId
                        ).reduce(done, accumulated, ++index);
                    }
                } else {
                    done(undefined, toPOJO(accumulated));
                }
            } catch (err) {
                done(err);
            }
        });
    }
/* c8 ignore next */
}

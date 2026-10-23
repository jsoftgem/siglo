export const getLogger = (config: Record<string, any>, props: Record<string, any>): void => {
    let logMonitor = () => false;
    if (props.logMonitor) {
        if (props.logMonitor instanceof Function) {
            logMonitor = props.logMonitor;
        } else {
            throw new Error('logMonitor must be a Function');
        }
    }
    config.logMonitor = logMonitor;
};

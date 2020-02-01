import {launch} from "./hyperion-launcher";

launch().catch((err) => {
    console.error(err);
}).finally(() => {
    console.log('Launch sequence complete!');
});

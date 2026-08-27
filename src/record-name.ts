import * as route53 from 'aws-cdk-lib/aws-route53';

/**
 * Compute the record name to use for an alias record whose fully-qualified
 * target is `fqdn`, inside the given hosted zone. Returns `undefined` for the
 * zone's apex, or the prefix portion for a subdomain.
 *
 * Supports `domainName` values that are subdomains of the supplied zone (e.g.
 * `status.example.com` inside `example.com`) as well as the zone apex itself.
 * Throws if the FQDN isn't inside the zone, which would otherwise silently
 * create a record under the wrong name.
 */
export function recordNameWithinZone(zone: route53.IHostedZone, fqdn: string): string | undefined {
    const zoneName = zone.zoneName.replace(/\.$/, '').toLowerCase();
    const name = fqdn.replace(/\.$/, '').toLowerCase();
    if (name === zoneName) {
        return undefined;
    }
    if (!name.endsWith(`.${zoneName}`)) {
        throw new Error(
            `Domain "${fqdn}" is not within hosted zone "${zoneName}". `
            + `Pass a zone that contains the domain, or set domainName to a name inside the zone.`,
        );
    }
    return name.slice(0, name.length - zoneName.length - 1);
}

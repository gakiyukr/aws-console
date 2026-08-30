// wavelength.js 的測試：移植自 aws-wavelength-console 的 21 項 utils 層
// 測試，AWS 互動以 env.__testHooks.fetch 注入 fake fetch、sleep 以
// __testHooks.sleep 短路（並記錄延遲以驗證輪詢節奏）。
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  WAVELENGTH_CLOUD_INIT_MARKER,
  buildCloudInit,
  chooseAvailableSubnetCidr,
  deployForwarderForExistingWavelengthInstance,
  deployRegionalEc2Instance,
  deployWavelengthInstance,
  generateRootPassword,
  initializeWavelengthZone,
  listEc2Regions,
  listExistingWavelengthInstances,
  listWavelengthInstanceTypes,
  listWavelengthOsOptions,
  listWavelengthRegions,
} from "../server/utils/wavelength.js";

// ── 測試輔助 ────────────────────────────────────────────────

/** 建立含 AWS 憑證與測試鉤子的 env。 */
function makeEnv(overrides = {}) {
  return {
    AWS_REGION: "us-east-1",
    AWS_ACCESS_KEY_ID: "key",
    AWS_SECRET_ACCESS_KEY: "secret",
    ...overrides,
  };
}

/** 自 Request init 取出 form-urlencoded 的 Action 參數。 */
function readAction(init) {
  return new URLSearchParams(String(init.body)).get("Action");
}

/** 建立 AWS 形態的 XML 回應。 */
function makeXmlResponse(xml, status = 200) {
  return new Response(xml, { status, headers: { "content-type": "application/xml" } });
}

// ── 純函式 ──────────────────────────────────────────────────

describe("generateRootPassword", () => {
  it("產生含大小寫、數字與符號的強密碼", () => {
    const password = generateRootPassword();

    assert.ok(password.length >= 24);
    assert.match(password, /[A-Z]/);
    assert.match(password, /[a-z]/);
    assert.match(password, /\d/);
    assert.match(password, /[^A-Za-z0-9]/);
  });
});

describe("buildCloudInit", () => {
  it("注入密碼與完成標記", () => {
    const password = "Abcd1234!Abcd1234!Abcd1234!";
    const cloudInit = buildCloudInit(password);

    assert.match(cloudInit, /ssh_pwauth: true/);
    assert.match(cloudInit, /PermitRootLogin yes/);
    assert.match(
      cloudInit,
      new RegExp(`password: "${password.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`),
    );
    assert.match(cloudInit, new RegExp(WAVELENGTH_CLOUD_INIT_MARKER));
  });

  it("對 YAML 敏感字元加引號跳脫", () => {
    const password = String.raw`![]{}&*"quoted"\slash`;
    const cloudInit = buildCloudInit(password);

    assert.ok(cloudInit.includes(String.raw`password: "![]{}&*\"quoted\"\\slash"`));
  });
});

describe("chooseAvailableSubnetCidr", () => {
  it("在 VPC 內挑選第一個未被佔用的 /26", () => {
    const cidr = chooseAvailableSubnetCidr("10.0.100.0/24", [
      "10.0.100.0/26",
      "10.0.100.64/26",
    ]);

    assert.equal(cidr, "10.0.100.128/26");
  });
});

describe("listEc2Regions", () => {
  it("列出全部已啟用 Region，不要求存在 Wavelength Zone", async () => {
    const env = makeEnv({
      __testHooks: {
        fetch: async (_url, init) => {
          assert.equal(readAction(init), "DescribeRegions");
          return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
            <DescribeRegionsResponse>
              <regionInfo>
                <item><regionName>us-west-2</regionName><optInStatus>opted-in</optInStatus></item>
                <item><regionName>ap-east-1</regionName><optInStatus>not-opted-in</optInStatus></item>
                <item><regionName>eu-west-2</regionName><optInStatus>opt-in-not-required</optInStatus></item>
              </regionInfo>
            </DescribeRegionsResponse>`);
        },
      },
    });

    assert.deepEqual(await listEc2Regions(env), ["eu-west-2", "us-west-2"]);
  });
});

describe("listWavelengthRegions", () => {
  it("僅保留擁有 Wavelength Zone 的地區", async () => {
    const env = makeEnv({
      __testHooks: {
        fetch: async (url, init) => {
          const action = readAction(init);
          if (action === "DescribeRegions") {
            return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
              <DescribeRegionsResponse>
                <regionInfo>
                  <item><regionName>eu-west-2</regionName><optInStatus>opt-in-not-required</optInStatus></item>
                  <item><regionName>us-west-2</regionName><optInStatus>opt-in-not-required</optInStatus></item>
                </regionInfo>
              </DescribeRegionsResponse>`);
          }

          if (action === "DescribeAvailabilityZones" && String(url).includes("eu-west-2")) {
            return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
              <DescribeAvailabilityZonesResponse>
                <availabilityZoneInfo>
                  <item>
                    <zoneName>eu-west-2-wl2-man-wlz-1</zoneName>
                    <zoneType>wavelength-zone</zoneType>
                    <optInStatus>opted-in</optInStatus>
                  </item>
                </availabilityZoneInfo>
              </DescribeAvailabilityZonesResponse>`);
          }

          if (action === "DescribeAvailabilityZones" && String(url).includes("us-west-2")) {
            return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
              <DescribeAvailabilityZonesResponse>
                <availabilityZoneInfo></availabilityZoneInfo>
              </DescribeAvailabilityZonesResponse>`);
          }

          throw new Error(`Unexpected request: ${action} ${url}`);
        },
      },
    });

    const regions = await listWavelengthRegions(env);

    assert.deepEqual(regions, ["eu-west-2"]);
  });

  it("忽略 Zone 查詢失敗的地區", async () => {
    const env = makeEnv({
      __testHooks: {
        fetch: async (url, init) => {
          const action = readAction(init);
          if (action === "DescribeRegions") {
            return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
              <DescribeRegionsResponse>
                <regionInfo>
                  <item><regionName>eu-west-2</regionName><optInStatus>opt-in-not-required</optInStatus></item>
                  <item><regionName>us-west-2</regionName><optInStatus>opt-in-not-required</optInStatus></item>
                </regionInfo>
              </DescribeRegionsResponse>`);
          }

          if (action === "DescribeAvailabilityZones" && String(url).includes("eu-west-2")) {
            return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
              <DescribeAvailabilityZonesResponse>
                <availabilityZoneInfo>
                  <item>
                    <zoneName>eu-west-2-wl2-man-wlz-1</zoneName>
                    <zoneType>wavelength-zone</zoneType>
                    <optInStatus>opted-in</optInStatus>
                  </item>
                </availabilityZoneInfo>
              </DescribeAvailabilityZonesResponse>`);
          }

          if (action === "DescribeAvailabilityZones" && String(url).includes("us-west-2")) {
            return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
              <Response>
                <Errors>
                  <Error>
                    <Code>UnauthorizedOperation</Code>
                    <Message>Not authorized for this region</Message>
                  </Error>
                </Errors>
              </Response>`, 403);
          }

          throw new Error(`Unexpected request: ${action} ${url}`);
        },
      },
    });

    const regions = await listWavelengthRegions(env);

    assert.deepEqual(regions, ["eu-west-2"]);
  });
});

describe("listWavelengthInstanceTypes", () => {
  it("依價位由小到大排序", async () => {
    const env = makeEnv({
      __testHooks: {
        fetch: async (url, init) => {
          const action = readAction(init);
          if (action !== "DescribeInstanceTypeOfferings") {
            throw new Error(`Unexpected request: ${action} ${url}`);
          }

          return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
            <DescribeInstanceTypeOfferingsResponse>
              <instanceTypeOfferingSet>
                <item><instanceType>g4dn.2xlarge</instanceType><location>zone-a</location></item>
                <item><instanceType>t3.xlarge</instanceType><location>zone-a</location></item>
                <item><instanceType>r5.2xlarge</instanceType><location>zone-a</location></item>
                <item><instanceType>t3.medium</instanceType><location>zone-a</location></item>
              </instanceTypeOfferingSet>
            </DescribeInstanceTypeOfferingsResponse>`);
        },
      },
    });

    const instanceTypes = await listWavelengthInstanceTypes(env, "eu-west-2", "zone-a");

    assert.deepEqual(instanceTypes, [
      "t3.medium",
      "t3.xlarge",
      "g4dn.2xlarge",
      "r5.2xlarge",
    ]);
  });
});

describe("listExistingWavelengthInstances", () => {
  it("依 WL Zone 與 VPC 過濾執行個體", async () => {
    const calls = [];
    const env = makeEnv({
      __testHooks: {
        fetch: async (url, init) => {
          calls.push({ url, init });
          assert.equal(readAction(init), "DescribeInstances");
          return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
            <DescribeInstancesResponse>
              <reservationSet>
                <item>
                  <instancesSet>
                    <item>
                      <instanceId>i-wl-1</instanceId>
                      <instanceState><name>running</name></instanceState>
                      <privateIpAddress>172.31.48.14</privateIpAddress>
                      <privateDnsName>ip-172-31-48-14.ap-northeast-1.compute.internal</privateDnsName>
                      <dnsName>ec2-106-161-84-90.ap-northeast-1.compute.amazonaws.com</dnsName>
                      <subnetId>subnet-wl</subnetId>
                      <vpcId>vpc-123</vpcId>
                      <placement><availabilityZone>ap-northeast-1-wl1-kix-wlz-1</availabilityZone></placement>
                    </item>
                  </instancesSet>
                </item>
              </reservationSet>
            </DescribeInstancesResponse>`);
        },
      },
    });

    const instances = await listExistingWavelengthInstances(env, {
      region: "ap-northeast-1",
      zone: "ap-northeast-1-wl1-kix-wlz-1",
      vpc_id: "vpc-123",
    });
    const params = new URLSearchParams(String(calls[0].init.body));

    assert.equal(params.get("Filter.1.Name"), "availability-zone");
    assert.equal(params.get("Filter.1.Value.1"), "ap-northeast-1-wl1-kix-wlz-1");
    assert.equal(params.get("Filter.2.Name"), "vpc-id");
    assert.equal(params.get("Filter.2.Value.1"), "vpc-123");
    assert.equal(params.get("Filter.3.Name"), "instance-state-name");
    assert.equal(instances.length, 1);
    assert.equal(instances[0].instance_id, "i-wl-1");
    assert.equal(instances[0].private_ip, "172.31.48.14");
  });
});

describe("listWavelengthOsOptions", () => {
  it("回傳支援的 Debian 版本", () => {
    assert.deepEqual(listWavelengthOsOptions(), [
      { value: "debian11", label: "Debian 11" },
      { value: "debian12", label: "Debian 12" },
      { value: "debian13", label: "Debian 13" },
    ]);
  });
});

// ── deployForwarderForExistingWavelengthInstance ────────────

describe("deployForwarderForExistingWavelengthInstance", () => {
  it("僅啟動 t3.nano 的區域型 forwarder", async () => {
    const calls = [];
    const progressEvents = [];
    const env = makeEnv({
      __testHooks: {
        sleep: async () => {},
        fetch: async (url, init) => {
          calls.push({ url, init });
          const action = readAction(init);
          const params = new URLSearchParams(String(init.body || ""));

          switch (action) {
            case "DescribeInstances": {
              const instanceId = params.get("InstanceId.1");
              if (instanceId === "i-wl-existing") {
                return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                  <DescribeInstancesResponse>
                    <reservationSet>
                      <item>
                        <instancesSet>
                          <item>
                            <instanceId>i-wl-existing</instanceId>
                            <instanceState><name>running</name></instanceState>
                            <privateIpAddress>10.0.100.10</privateIpAddress>
                            <privateDnsName>ip-10-0-100-10.eu-west-2.compute.internal</privateDnsName>
                            <dnsName>ec2-106-161-84-90.eu-west-2.compute.amazonaws.com</dnsName>
                            <subnetId>subnet-wl</subnetId>
                            <vpcId>vpc-123</vpcId>
                            <placement><availabilityZone>eu-west-2-wl2-man-wlz-1</availabilityZone></placement>
                          </item>
                        </instancesSet>
                      </item>
                    </reservationSet>
                  </DescribeInstancesResponse>`);
              }
              if (instanceId === "i-forwarder") {
                return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                  <DescribeInstancesResponse>
                    <reservationSet>
                      <item>
                        <instancesSet>
                          <item>
                            <instanceId>i-forwarder</instanceId>
                            <instanceState><name>running</name></instanceState>
                            <privateIpAddress>172.31.1.20</privateIpAddress>
                            <privateDnsName>ip-172-31-1-20.eu-west-2.compute.internal</privateDnsName>
                            <dnsName>ec2-18-4-5-6.eu-west-2.compute.amazonaws.com</dnsName>
                            <subnetId>subnet-regional</subnetId>
                            <vpcId>vpc-123</vpcId>
                            <placement><availabilityZone>eu-west-2a</availabilityZone></placement>
                          </item>
                        </instancesSet>
                      </item>
                    </reservationSet>
                  </DescribeInstancesResponse>`);
              }
              throw new Error(`Unexpected DescribeInstances id ${instanceId}`);
            }
            case "DescribeInstanceTypes":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <DescribeInstanceTypesResponse>
                  <instanceTypeSet>
                    <item>
                      <instanceType>t3.nano</instanceType>
                      <processorInfo>
                        <supportedArchitectureSet><item>x86_64</item></supportedArchitectureSet>
                      </processorInfo>
                    </item>
                  </instanceTypeSet>
                </DescribeInstanceTypesResponse>`);
            case "DescribeImages":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <DescribeImagesResponse>
                  <imagesSet>
                    <item>
                      <imageId>ami-forwarder</imageId>
                      <name>debian-12-amd64-20240501-1111</name>
                      <creationDate>2024-05-01T00:00:00.000Z</creationDate>
                      <rootDeviceName>/dev/sda1</rootDeviceName>
                      <blockDeviceMapping>
                        <item>
                          <deviceName>/dev/sda1</deviceName>
                          <ebs><snapshotId>snap-forwarder</snapshotId><volumeType>gp2</volumeType></ebs>
                        </item>
                      </blockDeviceMapping>
                    </item>
                  </imagesSet>
                </DescribeImagesResponse>`);
            case "DescribeVpcs":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <DescribeVpcsResponse>
                  <vpcSet>
                    <item><vpcId>vpc-123</vpcId><cidrBlock>172.31.0.0/16</cidrBlock></item>
                  </vpcSet>
                </DescribeVpcsResponse>`);
            case "DescribeSecurityGroups":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <DescribeSecurityGroupsResponse>
                  <securityGroupInfo>
                    <item>
                      <groupId>sg-123</groupId>
                      <vpcId>vpc-123</vpcId>
                      <ipPermissions>
                        <item>
                          <ipProtocol>-1</ipProtocol>
                          <ipRanges><item><cidrIp>0.0.0.0/0</cidrIp></item></ipRanges>
                        </item>
                      </ipPermissions>
                      <ipPermissionsEgress>
                        <item>
                          <ipProtocol>-1</ipProtocol>
                          <ipRanges><item><cidrIp>0.0.0.0/0</cidrIp></item></ipRanges>
                        </item>
                      </ipPermissionsEgress>
                    </item>
                  </securityGroupInfo>
                </DescribeSecurityGroupsResponse>`);
            case "DescribeSubnets":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <DescribeSubnetsResponse>
                  <subnetSet>
                    <item>
                      <subnetId>subnet-wl</subnetId>
                      <cidrBlock>172.31.48.0/26</cidrBlock>
                      <availabilityZone>eu-west-2-wl2-man-wlz-1</availabilityZone>
                      <vpcId>vpc-123</vpcId>
                    </item>
                    <item>
                      <subnetId>subnet-regional</subnetId>
                      <cidrBlock>172.31.1.0/24</cidrBlock>
                      <availabilityZone>eu-west-2a</availabilityZone>
                      <vpcId>vpc-123</vpcId>
                    </item>
                  </subnetSet>
                </DescribeSubnetsResponse>`);
            case "RunInstances":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <RunInstancesResponse>
                  <instancesSet><item><instanceId>i-forwarder</instanceId></item></instancesSet>
                </RunInstancesResponse>`);
            case "ModifyInstanceAttribute":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <ModifyInstanceAttributeResponse><return>true</return></ModifyInstanceAttributeResponse>`);
            case "DescribeInstanceStatus":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <DescribeInstanceStatusResponse>
                  <instanceStatusSet>
                    <item>
                      <instanceId>i-forwarder</instanceId>
                      <instanceStatus><status>ok</status></instanceStatus>
                      <systemStatus><status>ok</status></systemStatus>
                    </item>
                  </instanceStatusSet>
                </DescribeInstanceStatusResponse>`);
            case "GetConsoleOutput":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <GetConsoleOutputResponse>
                  <output>${Buffer.from(WAVELENGTH_CLOUD_INIT_MARKER).toString("base64")}</output>
                </GetConsoleOutputResponse>`);
            default:
              throw new Error(`Unexpected action ${action}`);
          }
        },
      },
    });

    const result = await deployForwarderForExistingWavelengthInstance(env, {
      region: "eu-west-2",
      zone: "eu-west-2-wl2-man-wlz-1",
      vpc_id: "vpc-123",
      instance_id: "i-wl-existing",
      os: "debian12",
    }, (stage, details = {}) => {
      progressEvents.push({ stage, ...details });
    });

    const runBodies = calls
      .filter((call) => readAction(call.init) === "RunInstances")
      .map((call) => String(call.init.body));
    const runParams = new URLSearchParams(runBodies[0]);
    const userData = Buffer.from(runParams.get("UserData"), "base64").toString("utf8");

    assert.equal(runBodies.length, 1);
    assert.equal(runParams.get("InstanceType"), "t3.nano");
    assert.equal(runParams.get("NetworkInterface.1.SubnetId"), "subnet-regional");
    assert.equal(runParams.get("NetworkInterface.1.AssociatePublicIpAddress"), "true");
    assert.equal(runParams.get("NetworkInterface.1.AssociateCarrierIpAddress"), null);
    assert.match(userData, /--to-destination 10\.0\.100\.10:22/);
    assert.equal(result.target_instance_id, "i-wl-existing");
    assert.equal(result.target_private_ip, "10.0.100.10");
    assert.equal(result.forwarder.instance_id, "i-forwarder");
    assert.equal(result.forwarder.instance_type, "t3.nano");
    assert.equal(progressEvents.some((event) =>
      event.stage === "root_password_generated" &&
      event.username === "root" &&
      event.password === result.forwarder.password
    ), true);
    assert.ok(calls.some((call) => readAction(call.init) === "ModifyInstanceAttribute"));
  });
});

// ── deployWavelengthInstance ────────────────────────────────

describe("deployWavelengthInstance", () => {
  /** 各測試共用的樁片段：已開通的 Zone 與可用類型。 */
  const OPTED_IN_ZONE_XML = `<?xml version="1.0" encoding="UTF-8"?>
    <DescribeAvailabilityZonesResponse>
      <availabilityZoneInfo>
        <item>
          <zoneName>eu-west-2-wl2-man-wlz-1</zoneName>
          <zoneType>wavelength-zone</zoneType>
          <optInStatus>opted-in</optInStatus>
        </item>
      </availabilityZoneInfo>
    </DescribeAvailabilityZonesResponse>`;
  const OFFERINGS_XML = `<?xml version="1.0" encoding="UTF-8"?>
    <DescribeInstanceTypeOfferingsResponse>
      <instanceTypeOfferingSet>
        <item>
          <instanceType>t3.medium</instanceType>
          <location>eu-west-2-wl2-man-wlz-1</location>
        </item>
      </instanceTypeOfferingSet>
    </DescribeInstanceTypeOfferingsResponse>`;

  it("執行個體 running 後等待公網 DNS 就緒", async () => {
    const calls = [];
    const sleepDelays = [];
    let describeInstancesCalls = 0;
    let consoleOutputCalls = 0;
    const env = makeEnv({
      __testHooks: {
        sleep: async (delayMs) => {
          sleepDelays.push(delayMs);
        },
        fetch: async (url, init) => {
          calls.push({ url, init });
          const action = readAction(init);

          switch (action) {
            case "DescribeAvailabilityZones":
              return makeXmlResponse(OPTED_IN_ZONE_XML);
            case "DescribeInstanceTypeOfferings":
              return makeXmlResponse(OFFERINGS_XML);
            case "DescribeInstanceTypes":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <DescribeInstanceTypesResponse>
                  <instanceTypeSet>
                    <item>
                      <instanceType>t3.medium</instanceType>
                      <processorInfo>
                        <supportedArchitectureSet>
                          <item>x86_64</item>
                        </supportedArchitectureSet>
                      </processorInfo>
                    </item>
                  </instanceTypeSet>
                </DescribeInstanceTypesResponse>`);
            case "DescribeVpcs":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <DescribeVpcsResponse>
                  <vpcSet>
                    <item>
                      <vpcId>vpc-123</vpcId>
                      <cidrBlock>10.0.100.0/24</cidrBlock>
                      <isDefault>true</isDefault>
                    </item>
                  </vpcSet>
                </DescribeVpcsResponse>`);
            case "DescribeSubnets":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <DescribeSubnetsResponse>
                  <subnetSet>
                    <item>
                      <subnetId>subnet-123</subnetId>
                      <cidrBlock>10.0.100.0/26</cidrBlock>
                      <availabilityZone>eu-west-2-wl2-man-wlz-1</availabilityZone>
                      <vpcId>vpc-123</vpcId>
                    </item>
                  </subnetSet>
                </DescribeSubnetsResponse>`);
            case "DescribeSecurityGroups":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <DescribeSecurityGroupsResponse>
                  <securityGroupInfo>
                    <item>
                      <groupId>sg-123</groupId>
                      <groupName>managed-all-open</groupName>
                      <vpcId>vpc-123</vpcId>
                      <ipPermissions>
                        <item>
                          <ipProtocol>-1</ipProtocol>
                          <ipRanges>
                            <item><cidrIp>0.0.0.0/0</cidrIp></item>
                          </ipRanges>
                        </item>
                      </ipPermissions>
                      <ipPermissionsEgress>
                        <item>
                          <ipProtocol>-1</ipProtocol>
                          <ipRanges>
                            <item><cidrIp>0.0.0.0/0</cidrIp></item>
                          </ipRanges>
                        </item>
                      </ipPermissionsEgress>
                    </item>
                  </securityGroupInfo>
                </DescribeSecurityGroupsResponse>`);
            case "DescribeImages":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <DescribeImagesResponse>
                  <imagesSet>
                    <item>
                      <imageId>ami-new</imageId>
                      <name>debian-12-amd64-20240501-1111</name>
                      <creationDate>2024-05-01T00:00:00.000Z</creationDate>
                      <rootDeviceName>/dev/sda1</rootDeviceName>
                      <blockDeviceMapping>
                        <item>
                          <deviceName>/dev/sda1</deviceName>
                          <ebs><snapshotId>snap-new</snapshotId></ebs>
                        </item>
                      </blockDeviceMapping>
                    </item>
                  </imagesSet>
                </DescribeImagesResponse>`);
            case "DescribeCarrierGateways":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <DescribeCarrierGatewaysResponse>
                  <carrierGatewaySet>
                    <item>
                      <carrierGatewayId>cagw-123</carrierGatewayId>
                      <vpcId>vpc-123</vpcId>
                      <state>available</state>
                    </item>
                  </carrierGatewaySet>
                </DescribeCarrierGatewaysResponse>`);
            case "DescribeRouteTables":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <DescribeRouteTablesResponse>
                  <routeTableSet>
                    <item>
                      <routeTableId>rtb-123</routeTableId>
                      <vpcId>vpc-123</vpcId>
                      <associationSet>
                        <item>
                          <routeTableAssociationId>rtbassoc-123</routeTableAssociationId>
                          <subnetId>subnet-123</subnetId>
                        </item>
                      </associationSet>
                      <routeSet>
                        <item>
                          <destinationCidrBlock>0.0.0.0/0</destinationCidrBlock>
                          <carrierGatewayId>cagw-123</carrierGatewayId>
                          <state>active</state>
                        </item>
                      </routeSet>
                    </item>
                  </routeTableSet>
                </DescribeRouteTablesResponse>`);
            case "RunInstances":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <RunInstancesResponse>
                  <instancesSet>
                    <item><instanceId>i-123</instanceId></item>
                  </instancesSet>
                </RunInstancesResponse>`);
            case "DescribeInstances":
              describeInstancesCalls += 1;
              if (describeInstancesCalls === 1) {
                return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                  <DescribeInstancesResponse>
                    <reservationSet>
                      <item>
                        <instancesSet>
                          <item>
                            <instanceId>i-123</instanceId>
                            <instanceState><name>pending</name></instanceState>
                          </item>
                        </instancesSet>
                      </item>
                    </reservationSet>
                  </DescribeInstancesResponse>`);
              }
              if (describeInstancesCalls === 2) {
                return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                  <DescribeInstancesResponse>
                    <reservationSet>
                      <item>
                        <instancesSet>
                          <item>
                            <instanceId>i-123</instanceId>
                            <instanceState><name>running</name></instanceState>
                            <privateIpAddress>10.0.100.10</privateIpAddress>
                            <privateDnsName>ip-10-0-100-10.eu-west-2.compute.internal</privateDnsName>
                          </item>
                        </instancesSet>
                      </item>
                    </reservationSet>
                  </DescribeInstancesResponse>`);
              }
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <DescribeInstancesResponse>
                  <reservationSet>
                    <item>
                      <instancesSet>
                        <item>
                          <instanceId>i-123</instanceId>
                          <instanceState><name>running</name></instanceState>
                          <privateIpAddress>10.0.100.10</privateIpAddress>
                          <privateDnsName>ip-10-0-100-10.eu-west-2.compute.internal</privateDnsName>
                          <dnsName>ec2-18-1-2-3.eu-west-2.compute.amazonaws.com</dnsName>
                        </item>
                      </instancesSet>
                    </item>
                  </reservationSet>
                </DescribeInstancesResponse>`);
            case "DescribeInstanceStatus":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <DescribeInstanceStatusResponse>
                  <instanceStatusSet>
                    <item>
                      <instanceId>i-123</instanceId>
                      <instanceStatus><status>ok</status></instanceStatus>
                      <systemStatus><status>ok</status></systemStatus>
                    </item>
                  </instanceStatusSet>
                </DescribeInstanceStatusResponse>`);
            case "GetConsoleOutput":
              consoleOutputCalls += 1;
              if (consoleOutputCalls === 1) {
                return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                  <GetConsoleOutputResponse>
                    <instanceId>i-123</instanceId>
                    <output>${Buffer.from("booting").toString("base64")}</output>
                  </GetConsoleOutputResponse>`);
              }
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <GetConsoleOutputResponse>
                  <instanceId>i-123</instanceId>
                  <output>${Buffer.from(WAVELENGTH_CLOUD_INIT_MARKER).toString("base64")}</output>
                </GetConsoleOutputResponse>`);
            default:
              throw new Error(`Unexpected action ${action}`);
          }
        },
      },
    });

    const result = await deployWavelengthInstance(env, {
      region: "eu-west-2",
      zone: "eu-west-2-wl2-man-wlz-1",
      vpc_id: "vpc-123",
      instance_type: "t3.medium",
      os: "debian12",
    });

    assert.equal(result.ready, true);
    assert.equal(result.public_dns_name, "ec2-18-1-2-3.eu-west-2.compute.amazonaws.com");
    assert.equal(result.private_dns_name, "ip-10-0-100-10.eu-west-2.compute.internal");
    assert.equal(result.ssh_command, "ssh root@ec2-18-1-2-3.eu-west-2.compute.amazonaws.com");
    assert.equal(calls.filter((call) => readAction(call.init) === "DescribeInstances").length, 3);
    assert.deepEqual(sleepDelays, [5000, 5000]);
  });

  it("自動為未開通的 Zone 執行 Opt-In 並輪詢等待生效", async () => {
    const calls = [];
    const sleepDelays = [];
    let zoneChecks = 0;
    const env = makeEnv({
      __testHooks: {
        sleep: async (delayMs) => {
          sleepDelays.push(delayMs);
        },
        fetch: async (url, init) => {
          calls.push({ url, init });
          const action = readAction(init);

          switch (action) {
            case "DescribeAvailabilityZones":
              zoneChecks += 1;
              if (zoneChecks === 1) {
                return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                  <DescribeAvailabilityZonesResponse>
                    <availabilityZoneInfo>
                      <item>
                        <groupName>ap-northeast-1-wl1-kix-wlz-1</groupName>
                        <zoneName>ap-northeast-1-wl1-kix-wlz-1</zoneName>
                        <zoneType>wavelength-zone</zoneType>
                        <optInStatus>not-opted-in</optInStatus>
                      </item>
                    </availabilityZoneInfo>
                  </DescribeAvailabilityZonesResponse>`);
              }
              if (zoneChecks === 2) {
                // 模擬 Opt-In 非同步生效：首次重查仍回報未開通
                return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                  <DescribeAvailabilityZonesResponse>
                    <availabilityZoneInfo>
                      <item>
                        <groupName>ap-northeast-1-wl1-kix-wlz-1</groupName>
                        <zoneName>ap-northeast-1-wl1-kix-wlz-1</zoneName>
                        <zoneType>wavelength-zone</zoneType>
                        <optInStatus>not-opted-in</optInStatus>
                      </item>
                    </availabilityZoneInfo>
                  </DescribeAvailabilityZonesResponse>`);
              }
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <DescribeAvailabilityZonesResponse>
                  <availabilityZoneInfo>
                    <item>
                      <groupName>ap-northeast-1-wl1-kix-wlz-1</groupName>
                      <zoneName>ap-northeast-1-wl1-kix-wlz-1</zoneName>
                      <zoneType>wavelength-zone</zoneType>
                      <optInStatus>opted-in</optInStatus>
                    </item>
                  </availabilityZoneInfo>
                </DescribeAvailabilityZonesResponse>`);
            case "ModifyAvailabilityZoneGroup":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <ModifyAvailabilityZoneGroupResponse>
                  <return>true</return>
                </ModifyAvailabilityZoneGroupResponse>`);
            case "DescribeVpcs":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <DescribeVpcsResponse>
                  <vpcSet>
                    <item>
                      <vpcId>vpc-123</vpcId>
                      <cidrBlock>10.0.100.0/24</cidrBlock>
                      <isDefault>true</isDefault>
                    </item>
                  </vpcSet>
                </DescribeVpcsResponse>`);
            case "DescribeSubnets":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <DescribeSubnetsResponse>
                  <subnetSet></subnetSet>
                </DescribeSubnetsResponse>`);
            case "DescribeSecurityGroups":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <DescribeSecurityGroupsResponse>
                  <securityGroupInfo></securityGroupInfo>
                </DescribeSecurityGroupsResponse>`);
            case "CreateSecurityGroup":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <CreateSecurityGroupResponse>
                  <groupId>sg-123</groupId>
                </CreateSecurityGroupResponse>`);
            case "AuthorizeSecurityGroupIngress":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <AuthorizeSecurityGroupIngressResponse><return>true</return></AuthorizeSecurityGroupIngressResponse>`);
            case "DescribeCarrierGateways":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <DescribeCarrierGatewaysResponse>
                  <carrierGatewaySet></carrierGatewaySet>
                </DescribeCarrierGatewaysResponse>`);
            case "CreateCarrierGateway":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <CreateCarrierGatewayResponse>
                  <carrierGateway>
                    <carrierGatewayId>cagw-123</carrierGatewayId>
                  </carrierGateway>
                </CreateCarrierGatewayResponse>`);
            case "CreateSubnet":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <CreateSubnetResponse>
                  <subnet>
                    <subnetId>subnet-123</subnetId>
                    <cidrBlock>10.0.100.0/26</cidrBlock>
                    <availabilityZone>ap-northeast-1-wl1-kix-wlz-1</availabilityZone>
                  </subnet>
                </CreateSubnetResponse>`);
            case "DescribeRouteTables":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <DescribeRouteTablesResponse>
                  <routeTableSet></routeTableSet>
                </DescribeRouteTablesResponse>`);
            case "CreateRouteTable":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <CreateRouteTableResponse>
                  <routeTable>
                    <routeTableId>rtb-123</routeTableId>
                  </routeTable>
                </CreateRouteTableResponse>`);
            case "CreateRoute":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <CreateRouteResponse><return>true</return></CreateRouteResponse>`);
            case "AssociateRouteTable":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <AssociateRouteTableResponse><associationId>rtbassoc-123</associationId></AssociateRouteTableResponse>`);
            default:
              throw new Error(`Unexpected action ${action}`);
          }
        },
      },
    });

    const result = await initializeWavelengthZone(env, {
      region: "ap-northeast-1",
      zone: "ap-northeast-1-wl1-kix-wlz-1",
      vpc_id: "vpc-123",
    });

    assert.equal(result.zone, "ap-northeast-1-wl1-kix-wlz-1");
    assert.ok(calls.some((call) => readAction(call.init) === "ModifyAvailabilityZoneGroup"));
    // Opt-In 為非同步生效：首次重查仍為 not-opted-in 時應輪詢等待而非立即失敗
    assert.equal(zoneChecks, 3);
    assert.deepEqual(sleepDelays, [3000, 3000]);
  });

  it("建立初始化所需的全部網路資源", async () => {
    const calls = [];
    const env = makeEnv({
      __testHooks: {
        fetch: async (url, init) => {
          calls.push({ url, init });
          const action = readAction(init);

          switch (action) {
            case "DescribeAvailabilityZones":
              return makeXmlResponse(OPTED_IN_ZONE_XML);
            case "DescribeVpcs":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <DescribeVpcsResponse>
                  <vpcSet>
                    <item>
                      <vpcId>vpc-123</vpcId>
                      <cidrBlock>10.0.100.0/24</cidrBlock>
                      <isDefault>true</isDefault>
                    </item>
                  </vpcSet>
                </DescribeVpcsResponse>`);
            case "DescribeSubnets":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <DescribeSubnetsResponse>
                  <subnetSet></subnetSet>
                </DescribeSubnetsResponse>`);
            case "DescribeSecurityGroups":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <DescribeSecurityGroupsResponse>
                  <securityGroupInfo></securityGroupInfo>
                </DescribeSecurityGroupsResponse>`);
            case "CreateSecurityGroup":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <CreateSecurityGroupResponse>
                  <groupId>sg-123</groupId>
                </CreateSecurityGroupResponse>`);
            case "AuthorizeSecurityGroupIngress":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <AuthorizeSecurityGroupIngressResponse><return>true</return></AuthorizeSecurityGroupIngressResponse>`);
            case "DescribeCarrierGateways":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <DescribeCarrierGatewaysResponse>
                  <carrierGatewaySet></carrierGatewaySet>
                </DescribeCarrierGatewaysResponse>`);
            case "CreateCarrierGateway":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <CreateCarrierGatewayResponse>
                  <carrierGateway>
                    <carrierGatewayId>cagw-123</carrierGatewayId>
                  </carrierGateway>
                </CreateCarrierGatewayResponse>`);
            case "CreateSubnet":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <CreateSubnetResponse>
                  <subnet>
                    <subnetId>subnet-123</subnetId>
                    <cidrBlock>10.0.100.0/26</cidrBlock>
                    <availabilityZone>eu-west-2-wl2-man-wlz-1</availabilityZone>
                  </subnet>
                </CreateSubnetResponse>`);
            case "DescribeRouteTables":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <DescribeRouteTablesResponse>
                  <routeTableSet></routeTableSet>
                </DescribeRouteTablesResponse>`);
            case "CreateRouteTable":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <CreateRouteTableResponse>
                  <routeTable>
                    <routeTableId>rtb-123</routeTableId>
                  </routeTable>
                </CreateRouteTableResponse>`);
            case "CreateRoute":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <CreateRouteResponse><return>true</return></CreateRouteResponse>`);
            case "AssociateRouteTable":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <AssociateRouteTableResponse><associationId>rtbassoc-123</associationId></AssociateRouteTableResponse>`);
            default:
              throw new Error(`Unexpected action ${action}`);
          }
        },
      },
    });

    const result = await initializeWavelengthZone(env, {
      region: "eu-west-2",
      zone: "eu-west-2-wl2-man-wlz-1",
      vpc_id: "vpc-123",
    });

    assert.equal(result.subnet_id, "subnet-123");
    assert.equal(result.carrier_gateway_id, "cagw-123");
    assert.equal(result.route_table_id, "rtb-123");
    assert.equal(result.security_group_id, "sg-123");
    assert.equal(result.zone, "eu-west-2-wl2-man-wlz-1");
    assert.ok(calls.some((call) => readAction(call.init) === "CreateSubnet"));
    assert.ok(calls.some((call) => readAction(call.init) === "CreateCarrierGateway"));
    assert.ok(calls.some((call) => readAction(call.init) === "CreateRouteTable"));
    assert.ok(calls.some((call) => readAction(call.init) === "CreateSecurityGroup"));
    const createSecurityGroupCall = calls.find(
      (call) => readAction(call.init) === "CreateSecurityGroup",
    );
    const createSecurityGroupParams = new URLSearchParams(String(createSecurityGroupCall.init.body));
    assert.equal(
      createSecurityGroupParams.get("GroupDescription"),
      "Managed full-access security group for Wavelength deployments",
    );
    assert.equal(createSecurityGroupParams.get("Description"), null);
  });

  it("重用既有資源時僅補標籤且不更動 Name", async () => {
    const calls = [];
    const env = makeEnv({
      __testHooks: {
        fetch: async (url, init) => {
          calls.push({ url, init });
          const action = readAction(init);

          switch (action) {
            case "DescribeAvailabilityZones":
              return makeXmlResponse(OPTED_IN_ZONE_XML);
            case "DescribeVpcs":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <DescribeVpcsResponse>
                  <vpcSet>
                    <item>
                      <vpcId>vpc-123</vpcId>
                      <cidrBlock>10.0.100.0/24</cidrBlock>
                      <isDefault>true</isDefault>
                    </item>
                  </vpcSet>
                </DescribeVpcsResponse>`);
            case "DescribeSubnets":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <DescribeSubnetsResponse>
                  <subnetSet>
                    <item>
                      <subnetId>subnet-existing</subnetId>
                      <cidrBlock>10.0.100.0/26</cidrBlock>
                      <availabilityZone>eu-west-2-wl2-man-wlz-1</availabilityZone>
                      <vpcId>vpc-123</vpcId>
                      <tagSet>
                        <item><key>Name</key><value>existing-subnet-name</value></item>
                      </tagSet>
                    </item>
                  </subnetSet>
                </DescribeSubnetsResponse>`);
            case "DescribeSecurityGroups":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <DescribeSecurityGroupsResponse>
                  <securityGroupInfo>
                    <item>
                      <groupId>sg-existing</groupId>
                      <groupName>existing-full-access</groupName>
                      <vpcId>vpc-123</vpcId>
                      <ipPermissions>
                        <item>
                          <ipProtocol>-1</ipProtocol>
                          <ipRanges>
                            <item><cidrIp>0.0.0.0/0</cidrIp></item>
                          </ipRanges>
                        </item>
                      </ipPermissions>
                      <ipPermissionsEgress>
                        <item>
                          <ipProtocol>-1</ipProtocol>
                          <ipRanges>
                            <item><cidrIp>0.0.0.0/0</cidrIp></item>
                          </ipRanges>
                        </item>
                      </ipPermissionsEgress>
                    </item>
                  </securityGroupInfo>
                </DescribeSecurityGroupsResponse>`);
            case "DescribeCarrierGateways":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <DescribeCarrierGatewaysResponse>
                  <carrierGatewaySet>
                    <item>
                      <carrierGatewayId>cagw-existing</carrierGatewayId>
                      <vpcId>vpc-123</vpcId>
                      <state>available</state>
                    </item>
                  </carrierGatewaySet>
                </DescribeCarrierGatewaysResponse>`);
            case "DescribeRouteTables":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <DescribeRouteTablesResponse>
                  <routeTableSet>
                    <item>
                      <routeTableId>rtb-existing</routeTableId>
                      <vpcId>vpc-123</vpcId>
                      <associationSet>
                        <item>
                          <routeTableAssociationId>rtbassoc-existing</routeTableAssociationId>
                          <subnetId>subnet-existing</subnetId>
                        </item>
                      </associationSet>
                      <routeSet>
                        <item>
                          <destinationCidrBlock>0.0.0.0/0</destinationCidrBlock>
                          <carrierGatewayId>cagw-existing</carrierGatewayId>
                          <state>active</state>
                        </item>
                      </routeSet>
                    </item>
                  </routeTableSet>
                </DescribeRouteTablesResponse>`);
            case "CreateTags":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <CreateTagsResponse><return>true</return></CreateTagsResponse>`);
            default:
              throw new Error(`Unexpected action ${action}`);
          }
        },
      },
    });

    const result = await initializeWavelengthZone(env, {
      region: "eu-west-2",
      zone: "eu-west-2-wl2-man-wlz-1",
      vpc_id: "vpc-123",
    });

    const createTagsCalls = calls.filter((call) => readAction(call.init) === "CreateTags");
    const createTagsBodies = createTagsCalls.map((call) => String(call.init.body));

    assert.equal(result.subnet_id, "subnet-existing");
    assert.equal(result.carrier_gateway_id, "cagw-existing");
    assert.equal(result.route_table_id, "rtb-existing");
    assert.equal(result.security_group_id, "sg-existing");
    assert.equal(createTagsCalls.length, 4);
    assert.ok(createTagsBodies.some((body) => body.includes("ResourceId.1=subnet-existing")));
    assert.ok(createTagsBodies.some((body) => body.includes("ResourceId.1=cagw-existing")));
    assert.ok(createTagsBodies.some((body) => body.includes("ResourceId.1=sg-existing")));
    assert.ok(createTagsBodies.some((body) => body.includes("ResourceId.1=rtb-existing")));
    for (const body of createTagsBodies) {
      assert.match(body, /Tag\.1\.Key=ManagedBy/);
      assert.match(body, /Tag\.2\.Key=Feature/);
      assert.match(body, /Tag\.3\.Key=WavelengthZone/);
      assert.doesNotMatch(body, /Name/);
    }
  });

  it("使用已初始化資源啟動執行個體", async () => {
    const calls = [];
    const sleepDelays = [];
    let describeInstancesCalls = 0;
    let describeInstanceStatusCalls = 0;
    let consoleOutputCalls = 0;
    const env = makeEnv({
      __testHooks: {
        sleep: async (delayMs) => {
          sleepDelays.push(delayMs);
        },
        fetch: async (url, init) => {
          calls.push({ url, init });
          const action = readAction(init);

          switch (action) {
            case "DescribeAvailabilityZones":
              return makeXmlResponse(OPTED_IN_ZONE_XML);
            case "DescribeInstanceTypeOfferings":
              return makeXmlResponse(OFFERINGS_XML);
            case "DescribeInstanceTypes":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <DescribeInstanceTypesResponse>
                  <instanceTypeSet>
                    <item>
                      <instanceType>t3.medium</instanceType>
                      <processorInfo>
                        <supportedArchitectureSet>
                          <item>x86_64</item>
                        </supportedArchitectureSet>
                      </processorInfo>
                    </item>
                  </instanceTypeSet>
                </DescribeInstanceTypesResponse>`);
            case "DescribeVpcs":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <DescribeVpcsResponse>
                  <vpcSet>
                    <item>
                      <vpcId>vpc-123</vpcId>
                      <cidrBlock>10.0.100.0/24</cidrBlock>
                      <isDefault>true</isDefault>
                    </item>
                  </vpcSet>
                </DescribeVpcsResponse>`);
            case "DescribeSubnets":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <DescribeSubnetsResponse>
                  <subnetSet>
                    <item>
                      <subnetId>subnet-123</subnetId>
                      <cidrBlock>10.0.100.0/26</cidrBlock>
                      <availabilityZone>eu-west-2-wl2-man-wlz-1</availabilityZone>
                      <vpcId>vpc-123</vpcId>
                    </item>
                  </subnetSet>
                </DescribeSubnetsResponse>`);
            case "DescribeSecurityGroups":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <DescribeSecurityGroupsResponse>
                  <securityGroupInfo>
                    <item>
                      <groupId>sg-123</groupId>
                      <groupName>managed-all-open</groupName>
                      <vpcId>vpc-123</vpcId>
                      <ipPermissions>
                        <item>
                          <ipProtocol>-1</ipProtocol>
                          <ipRanges>
                            <item><cidrIp>0.0.0.0/0</cidrIp></item>
                          </ipRanges>
                        </item>
                      </ipPermissions>
                      <ipPermissionsEgress>
                        <item>
                          <ipProtocol>-1</ipProtocol>
                          <ipRanges>
                            <item><cidrIp>0.0.0.0/0</cidrIp></item>
                          </ipRanges>
                        </item>
                      </ipPermissionsEgress>
                    </item>
                  </securityGroupInfo>
                </DescribeSecurityGroupsResponse>`);
            case "DescribeImages":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <DescribeImagesResponse>
                  <imagesSet>
                    <item>
                      <imageId>ami-old</imageId>
                      <name>debian-12-amd64-20240101-1111</name>
                      <creationDate>2024-01-01T00:00:00.000Z</creationDate>
                      <rootDeviceName>/dev/sda1</rootDeviceName>
                      <blockDeviceMapping>
                        <item>
                          <deviceName>/dev/sda1</deviceName>
                          <ebs>
                            <snapshotId>snap-old</snapshotId>
                          </ebs>
                        </item>
                      </blockDeviceMapping>
                    </item>
                    <item>
                      <imageId>ami-new</imageId>
                      <name>debian-12-amd64-20240501-1111</name>
                      <creationDate>2024-05-01T00:00:00.000Z</creationDate>
                      <rootDeviceName>/dev/sda1</rootDeviceName>
                      <blockDeviceMapping>
                        <item>
                          <deviceName>/dev/sda1</deviceName>
                          <ebs>
                            <snapshotId>snap-new</snapshotId>
                          </ebs>
                        </item>
                      </blockDeviceMapping>
                    </item>
                  </imagesSet>
                </DescribeImagesResponse>`);
            case "DescribeCarrierGateways":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <DescribeCarrierGatewaysResponse>
                  <carrierGatewaySet>
                    <item>
                      <carrierGatewayId>cagw-123</carrierGatewayId>
                      <vpcId>vpc-123</vpcId>
                      <state>available</state>
                    </item>
                  </carrierGatewaySet>
                </DescribeCarrierGatewaysResponse>`);
            case "DescribeRouteTables":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <DescribeRouteTablesResponse>
                  <routeTableSet>
                    <item>
                      <routeTableId>rtb-123</routeTableId>
                      <vpcId>vpc-123</vpcId>
                      <associationSet>
                        <item>
                          <routeTableAssociationId>rtbassoc-123</routeTableAssociationId>
                          <subnetId>subnet-123</subnetId>
                        </item>
                      </associationSet>
                      <routeSet>
                        <item>
                          <destinationCidrBlock>0.0.0.0/0</destinationCidrBlock>
                          <carrierGatewayId>cagw-123</carrierGatewayId>
                          <state>active</state>
                        </item>
                      </routeSet>
                    </item>
                    <tagSet>
                      <item>
                        <key>WavelengthZone</key>
                        <value>eu-west-2-wl2-man-wlz-1</value>
                      </item>
                    </tagSet>
                  </routeTableSet>
                </DescribeRouteTablesResponse>`);
            case "RunInstances":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <RunInstancesResponse>
                  <instancesSet>
                    <item>
                      <instanceId>i-123</instanceId>
                    </item>
                  </instancesSet>
                </RunInstancesResponse>`);
            case "DescribeInstances":
              describeInstancesCalls += 1;
              if (describeInstancesCalls === 1) {
                return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                  <DescribeInstancesResponse>
                    <reservationSet>
                      <item>
                        <instancesSet>
                          <item>
                            <instanceId>i-123</instanceId>
                            <instanceState><name>pending</name></instanceState>
                          </item>
                        </instancesSet>
                      </item>
                    </reservationSet>
                  </DescribeInstancesResponse>`);
              }
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <DescribeInstancesResponse>
                  <reservationSet>
                    <item>
                      <instancesSet>
                        <item>
                          <instanceId>i-123</instanceId>
                          <instanceState><name>running</name></instanceState>
                          <privateIpAddress>10.0.100.10</privateIpAddress>
                          <privateDnsName>ip-10-0-100-10.eu-west-2.compute.internal</privateDnsName>
                          <dnsName>ec2-18-1-2-3.eu-west-2.compute.amazonaws.com</dnsName>
                        </item>
                      </instancesSet>
                    </item>
                  </reservationSet>
                </DescribeInstancesResponse>`);
            case "DescribeInstanceStatus":
              describeInstanceStatusCalls += 1;
              if (describeInstanceStatusCalls === 1) {
                return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                  <DescribeInstanceStatusResponse>
                    <instanceStatusSet>
                      <item>
                        <instanceId>i-123</instanceId>
                        <instanceStatus><status>initializing</status></instanceStatus>
                        <systemStatus><status>initializing</status></systemStatus>
                      </item>
                    </instanceStatusSet>
                  </DescribeInstanceStatusResponse>`);
              }
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <DescribeInstanceStatusResponse>
                  <instanceStatusSet>
                    <item>
                      <instanceId>i-123</instanceId>
                      <instanceStatus><status>ok</status></instanceStatus>
                      <systemStatus><status>ok</status></systemStatus>
                    </item>
                  </instanceStatusSet>
                </DescribeInstanceStatusResponse>`);
            case "GetConsoleOutput":
              consoleOutputCalls += 1;
              if (consoleOutputCalls === 1) {
                return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                  <GetConsoleOutputResponse>
                    <instanceId>i-123</instanceId>
                    <output>${Buffer.from("booting").toString("base64")}</output>
                  </GetConsoleOutputResponse>`);
              }
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <GetConsoleOutputResponse>
                  <instanceId>i-123</instanceId>
                  <output>${Buffer.from(WAVELENGTH_CLOUD_INIT_MARKER).toString("base64")}</output>
                </GetConsoleOutputResponse>`);
            default:
              throw new Error(`Unexpected action ${action}`);
          }
        },
      },
    });

    const result = await deployWavelengthInstance(env, {
      region: "eu-west-2",
      zone: "eu-west-2-wl2-man-wlz-1",
      vpc_id: "vpc-123",
      instance_type: "t3.medium",
      os: "debian12",
    });

    const runInstancesCall = calls.find((call) => readAction(call.init) === "RunInstances");
    const runInstancesBody = String(runInstancesCall.init.body);
    const runInstancesParams = new URLSearchParams(runInstancesBody);

    assert.equal(result.instance_id, "i-123");
    assert.equal(result.state, "running");
    assert.equal(result.private_ip, "10.0.100.10");
    assert.equal(result.public_dns_name, "ec2-18-1-2-3.eu-west-2.compute.amazonaws.com");
    assert.equal(result.private_dns_name, "ip-10-0-100-10.eu-west-2.compute.internal");
    assert.equal(result.subnet_id, "subnet-123");
    assert.equal(result.carrier_gateway_id, "cagw-123");
    assert.equal(result.route_table_id, "rtb-123");
    assert.equal(result.username, "root");
    assert.match(result.password, /[A-Z]/);
    assert.equal(result.ssh_command, "ssh root@ec2-18-1-2-3.eu-west-2.compute.amazonaws.com");
    assert.deepEqual(sleepDelays, [5000, 5000, 5000]);
    assert.match(runInstancesBody, /AssociateCarrierIpAddress=true/);
    assert.match(runInstancesBody, /NetworkInterface\.1\.SecurityGroupId\.1=sg-123/);
    assert.doesNotMatch(runInstancesBody, /NetworkInterface\.1\.Groups\.1=sg-123/);
    assert.doesNotMatch(runInstancesBody, /KeyName=/);
    assert.equal(runInstancesParams.get("BlockDeviceMapping.1.DeviceName"), "/dev/sda1");
    assert.equal(runInstancesParams.get("BlockDeviceMapping.1.Ebs.SnapshotId"), "snap-new");
    assert.equal(runInstancesParams.get("BlockDeviceMapping.1.Ebs.VolumeType"), "gp2");
    assert.ok(!calls.some((call) => readAction(call.init) === "CreateSubnet"));
    assert.ok(!calls.some((call) => readAction(call.init) === "CreateCarrierGateway"));
  });

  it("可同時啟動 WL 執行個體與區域型 forwarder", async () => {
    const calls = [];
    let runInstancesCalls = 0;
    let forwarderDescribeFailures = 0;
    const env = makeEnv({
      __testHooks: {
        sleep: async () => {},
        fetch: async (url, init) => {
          calls.push({ url, init });
          const action = readAction(init);

          switch (action) {
            case "DescribeAvailabilityZones":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <DescribeAvailabilityZonesResponse>
                  <availabilityZoneInfo>
                    <item>
                      <zoneName>eu-west-2-wl2-man-wlz-1</zoneName>
                      <zoneType>wavelength-zone</zoneType>
                      <optInStatus>opted-in</optInStatus>
                    </item>
                    <item>
                      <zoneName>eu-west-2a</zoneName>
                      <zoneType>availability-zone</zoneType>
                      <optInStatus>opt-in-not-required</optInStatus>
                    </item>
                  </availabilityZoneInfo>
                </DescribeAvailabilityZonesResponse>`);
            case "DescribeInstanceTypeOfferings":
              return makeXmlResponse(OFFERINGS_XML);
            case "DescribeInstanceTypes":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <DescribeInstanceTypesResponse>
                  <instanceTypeSet>
                    <item>
                      <instanceType>t3.medium</instanceType>
                      <processorInfo>
                        <supportedArchitectureSet>
                          <item>x86_64</item>
                        </supportedArchitectureSet>
                      </processorInfo>
                    </item>
                  </instanceTypeSet>
                </DescribeInstanceTypesResponse>`);
            case "DescribeImages":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <DescribeImagesResponse>
                  <imagesSet>
                    <item>
                      <imageId>ami-new</imageId>
                      <name>debian-12-amd64-20240501-1111</name>
                      <creationDate>2024-05-01T00:00:00.000Z</creationDate>
                      <rootDeviceName>/dev/sda1</rootDeviceName>
                      <blockDeviceMapping>
                        <item>
                          <deviceName>/dev/sda1</deviceName>
                          <ebs><snapshotId>snap-new</snapshotId></ebs>
                        </item>
                      </blockDeviceMapping>
                    </item>
                  </imagesSet>
                </DescribeImagesResponse>`);
            case "DescribeVpcs":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <DescribeVpcsResponse>
                  <vpcSet>
                    <item>
                      <vpcId>vpc-123</vpcId>
                      <cidrBlock>10.0.100.0/24</cidrBlock>
                      <isDefault>true</isDefault>
                    </item>
                  </vpcSet>
                </DescribeVpcsResponse>`);
            case "DescribeSubnets":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <DescribeSubnetsResponse>
                  <subnetSet>
                    <item>
                      <subnetId>subnet-wl</subnetId>
                      <cidrBlock>10.0.100.0/26</cidrBlock>
                      <availabilityZone>eu-west-2-wl2-man-wlz-1</availabilityZone>
                      <vpcId>vpc-123</vpcId>
                    </item>
                    <item>
                      <subnetId>subnet-regional</subnetId>
                      <cidrBlock>10.0.100.64/26</cidrBlock>
                      <availabilityZone>eu-west-2a</availabilityZone>
                      <vpcId>vpc-123</vpcId>
                    </item>
                  </subnetSet>
                </DescribeSubnetsResponse>`);
            case "DescribeSecurityGroups":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <DescribeSecurityGroupsResponse>
                  <securityGroupInfo>
                    <item>
                      <groupId>sg-123</groupId>
                      <vpcId>vpc-123</vpcId>
                      <ipPermissions>
                        <item>
                          <ipProtocol>-1</ipProtocol>
                          <ipRanges><item><cidrIp>0.0.0.0/0</cidrIp></item></ipRanges>
                        </item>
                      </ipPermissions>
                      <ipPermissionsEgress>
                        <item>
                          <ipProtocol>-1</ipProtocol>
                          <ipRanges><item><cidrIp>0.0.0.0/0</cidrIp></item></ipRanges>
                        </item>
                      </ipPermissionsEgress>
                    </item>
                  </securityGroupInfo>
                </DescribeSecurityGroupsResponse>`);
            case "DescribeCarrierGateways":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <DescribeCarrierGatewaysResponse>
                  <carrierGatewaySet>
                    <item>
                      <carrierGatewayId>cagw-123</carrierGatewayId>
                      <vpcId>vpc-123</vpcId>
                      <state>available</state>
                    </item>
                  </carrierGatewaySet>
                </DescribeCarrierGatewaysResponse>`);
            case "DescribeRouteTables":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <DescribeRouteTablesResponse>
                  <routeTableSet>
                    <item>
                      <routeTableId>rtb-123</routeTableId>
                      <vpcId>vpc-123</vpcId>
                      <associationSet>
                        <item><subnetId>subnet-wl</subnetId></item>
                      </associationSet>
                      <routeSet>
                        <item>
                          <destinationCidrBlock>0.0.0.0/0</destinationCidrBlock>
                          <carrierGatewayId>cagw-123</carrierGatewayId>
                          <state>active</state>
                        </item>
                      </routeSet>
                    </item>
                  </routeTableSet>
                </DescribeRouteTablesResponse>`);
            case "RunInstances":
              runInstancesCalls += 1;
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <RunInstancesResponse>
                  <instancesSet>
                    <item>
                      <instanceId>${runInstancesCalls === 1 ? "i-wl" : "i-forwarder"}</instanceId>
                    </item>
                  </instancesSet>
                </RunInstancesResponse>`);
            case "ModifyInstanceAttribute":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <ModifyInstanceAttributeResponse><return>true</return></ModifyInstanceAttributeResponse>`);
            case "DescribeInstances": {
              const instanceId = new URLSearchParams(String(init.body)).get("InstanceId.1");
              const isForwarder = instanceId === "i-forwarder";
              if (isForwarder && forwarderDescribeFailures === 0) {
                forwarderDescribeFailures += 1;
                return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                  <Response>
                    <Errors>
                      <Error>
                        <Code>InternalError</Code>
                        <Message>Internal Server Error</Message>
                      </Error>
                    </Errors>
                  </Response>`, 500);
              }
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <DescribeInstancesResponse>
                  <reservationSet>
                    <item>
                      <instancesSet>
                        <item>
                          <instanceId>${instanceId}</instanceId>
                          <instanceState><name>running</name></instanceState>
                          <privateIpAddress>${isForwarder ? "10.0.100.70" : "10.0.100.10"}</privateIpAddress>
                          <privateDnsName>${isForwarder ? "ip-10-0-100-70.eu-west-2.compute.internal" : "ip-10-0-100-10.eu-west-2.compute.internal"}</privateDnsName>
                          <dnsName>${isForwarder ? "ec2-18-4-5-6.eu-west-2.compute.amazonaws.com" : "ec2-18-1-2-3.eu-west-2.compute.amazonaws.com"}</dnsName>
                        </item>
                      </instancesSet>
                    </item>
                  </reservationSet>
                </DescribeInstancesResponse>`);
            }
            case "DescribeInstanceStatus":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <DescribeInstanceStatusResponse>
                  <instanceStatusSet>
                    <item>
                      <instanceStatus><status>ok</status></instanceStatus>
                      <systemStatus><status>ok</status></systemStatus>
                    </item>
                  </instanceStatusSet>
                </DescribeInstanceStatusResponse>`);
            case "GetConsoleOutput":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <GetConsoleOutputResponse>
                  <output>${Buffer.from(WAVELENGTH_CLOUD_INIT_MARKER).toString("base64")}</output>
                </GetConsoleOutputResponse>`);
            default:
              throw new Error(`Unexpected action ${action}`);
          }
        },
      },
    });

    const result = await deployWavelengthInstance(env, {
      region: "eu-west-2",
      zone: "eu-west-2-wl2-man-wlz-1",
      vpc_id: "vpc-123",
      instance_type: "t3.medium",
      regional_instance_type: "t3.medium",
      os: "debian12",
      enable_forwarder: true,
    });

    const runBodies = calls
      .filter((call) => readAction(call.init) === "RunInstances")
      .map((call) => String(call.init.body));
    assert.equal(runBodies.length, 2);
    const forwarderParams = new URLSearchParams(runBodies[1]);
    const forwarderUserData = Buffer.from(forwarderParams.get("UserData"), "base64").toString("utf8");

    assert.match(runBodies[0], /AssociateCarrierIpAddress=true/);
    assert.equal(forwarderParams.get("InstanceType"), "t3.nano");
    assert.equal(forwarderParams.get("NetworkInterface.1.SubnetId"), "subnet-regional");
    assert.equal(forwarderParams.get("NetworkInterface.1.AssociatePublicIpAddress"), "true");
    assert.doesNotMatch(runBodies[1], /AssociateCarrierIpAddress/);
    assert.match(forwarderUserData, /net\.ipv4\.ip_forward=1/);
    assert.match(forwarderUserData, /--to-destination 10\.0\.100\.10:22/);
    assert.match(forwarderUserData, new RegExp(`--dport ${result.forwarder.listen_port}`));
    assert.equal(result.forwarder.instance_id, "i-forwarder");
    assert.equal(result.forwarder.target_private_ip, "10.0.100.10");
    assert.equal(result.forwarder.target_port, 22);
    assert.equal(
      result.forwarder.ssh_command,
      `ssh -p ${result.forwarder.listen_port} root@ec2-18-4-5-6.eu-west-2.compute.amazonaws.com`,
    );
    assert.ok(calls.some((call) => readAction(call.init) === "ModifyInstanceAttribute"));
    assert.equal(forwarderDescribeFailures, 1);
  });

  it("forwarder 就緒後不再對 WL 執行個體執行狀態檢查", async () => {
    const calls = [];
    let runInstancesCalls = 0;
    const env = makeEnv({
      __testHooks: {
        sleep: async () => {},
        fetch: async (url, init) => {
          calls.push({ url, init });
          const action = readAction(init);
          const params = new URLSearchParams(String(init.body || ""));

          switch (action) {
            case "DescribeAvailabilityZones":
              return makeXmlResponse(OPTED_IN_ZONE_XML);
            case "DescribeInstanceTypeOfferings":
              return makeXmlResponse(OFFERINGS_XML);
            case "DescribeInstanceTypes":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <DescribeInstanceTypesResponse>
                  <instanceTypeSet>
                    <item>
                      <instanceType>${params.get("InstanceType.1")}</instanceType>
                      <processorInfo><supportedArchitectureSet><item>x86_64</item></supportedArchitectureSet></processorInfo>
                    </item>
                  </instanceTypeSet>
                </DescribeInstanceTypesResponse>`);
            case "DescribeImages":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <DescribeImagesResponse>
                  <imagesSet>
                    <item>
                      <imageId>ami-123</imageId>
                      <creationDate>2024-05-01T00:00:00.000Z</creationDate>
                      <rootDeviceName>/dev/sda1</rootDeviceName>
                      <blockDeviceMapping>
                        <item><deviceName>/dev/sda1</deviceName><ebs><snapshotId>snap-123</snapshotId></ebs></item>
                      </blockDeviceMapping>
                    </item>
                  </imagesSet>
                </DescribeImagesResponse>`);
            case "DescribeVpcs":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <DescribeVpcsResponse>
                  <vpcSet><item><vpcId>vpc-123</vpcId><cidrBlock>172.31.0.0/16</cidrBlock></item></vpcSet>
                </DescribeVpcsResponse>`);
            case "DescribeSubnets":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <DescribeSubnetsResponse>
                  <subnetSet>
                    <item>
                      <subnetId>subnet-wl</subnetId>
                      <cidrBlock>172.31.48.0/26</cidrBlock>
                      <availabilityZone>eu-west-2-wl2-man-wlz-1</availabilityZone>
                      <vpcId>vpc-123</vpcId>
                    </item>
                    <item>
                      <subnetId>subnet-regional</subnetId>
                      <cidrBlock>172.31.1.0/24</cidrBlock>
                      <availabilityZone>eu-west-2a</availabilityZone>
                      <vpcId>vpc-123</vpcId>
                    </item>
                  </subnetSet>
                </DescribeSubnetsResponse>`);
            case "DescribeCarrierGateways":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <DescribeCarrierGatewaysResponse>
                  <carrierGatewaySet><item><carrierGatewayId>cagw-123</carrierGatewayId><vpcId>vpc-123</vpcId></item></carrierGatewaySet>
                </DescribeCarrierGatewaysResponse>`);
            case "DescribeSecurityGroups":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <DescribeSecurityGroupsResponse>
                  <securityGroupInfo>
                    <item>
                      <groupId>sg-123</groupId>
                      <vpcId>vpc-123</vpcId>
                      <ipPermissions><item><ipProtocol>-1</ipProtocol><ipRanges><item><cidrIp>0.0.0.0/0</cidrIp></item></ipRanges></item></ipPermissions>
                      <ipPermissionsEgress><item><ipProtocol>-1</ipProtocol><ipRanges><item><cidrIp>0.0.0.0/0</cidrIp></item></ipRanges></item></ipPermissionsEgress>
                    </item>
                  </securityGroupInfo>
                </DescribeSecurityGroupsResponse>`);
            case "DescribeRouteTables":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <DescribeRouteTablesResponse>
                  <routeTableSet>
                    <item>
                      <routeTableId>rtb-123</routeTableId>
                      <associationSet><item><subnetId>subnet-wl</subnetId></item></associationSet>
                      <routeSet><item><destinationCidrBlock>0.0.0.0/0</destinationCidrBlock><carrierGatewayId>cagw-123</carrierGatewayId><state>active</state></item></routeSet>
                    </item>
                  </routeTableSet>
                </DescribeRouteTablesResponse>`);
            case "RunInstances":
              runInstancesCalls += 1;
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <RunInstancesResponse>
                  <instancesSet><item><instanceId>${runInstancesCalls === 1 ? "i-wl" : "i-forwarder"}</instanceId></item></instancesSet>
                </RunInstancesResponse>`);
            case "ModifyInstanceAttribute":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <ModifyInstanceAttributeResponse><return>true</return></ModifyInstanceAttributeResponse>`);
            case "DescribeInstances": {
              const instanceId = params.get("InstanceId.1");
              const isForwarder = instanceId === "i-forwarder";
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <DescribeInstancesResponse>
                  <reservationSet>
                    <item>
                      <instancesSet>
                        <item>
                          <instanceId>${instanceId}</instanceId>
                          <instanceState><name>running</name></instanceState>
                          <privateIpAddress>${isForwarder ? "172.31.1.20" : "172.31.48.13"}</privateIpAddress>
                          <privateDnsName>${isForwarder ? "ip-172-31-1-20.eu-west-2.compute.internal" : "ip-172-31-48-13.eu-west-2.compute.internal"}</privateDnsName>
                          <dnsName>${isForwarder ? "ec2-18-4-5-6.eu-west-2.compute.amazonaws.com" : "ec2-106-161-80-155.eu-west-2.compute.amazonaws.com"}</dnsName>
                        </item>
                      </instancesSet>
                    </item>
                  </reservationSet>
                </DescribeInstancesResponse>`);
            }
            case "DescribeInstanceStatus": {
              const instanceId = params.get("InstanceId.1");
              if (instanceId === "i-wl") {
                throw new Error("WL status checks should not run after the forwarder is ready");
              }
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <DescribeInstanceStatusResponse>
                  <instanceStatusSet>
                    <item>
                      <instanceId>${instanceId}</instanceId>
                      <instanceStatus><status>ok</status></instanceStatus>
                      <systemStatus><status>ok</status></systemStatus>
                    </item>
                  </instanceStatusSet>
                </DescribeInstanceStatusResponse>`);
            }
            case "GetConsoleOutput":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <GetConsoleOutputResponse>
                  <output>${Buffer.from(WAVELENGTH_CLOUD_INIT_MARKER).toString("base64")}</output>
                </GetConsoleOutputResponse>`);
            default:
              throw new Error(`Unexpected action ${action}`);
          }
        },
      },
    });

    const result = await deployWavelengthInstance(env, {
      region: "eu-west-2",
      zone: "eu-west-2-wl2-man-wlz-1",
      vpc_id: "vpc-123",
      instance_type: "t3.medium",
      os: "debian12",
      enable_forwarder: true,
    });

    const runBodies = calls
      .filter((call) => readAction(call.init) === "RunInstances")
      .map((call) => String(call.init.body));
    assert.equal(runBodies.length, 2);
    assert.equal(result.ready, true);
    assert.equal(result.instance_id, "i-wl");
    assert.equal(result.forwarder.instance_id, "i-forwarder");
    assert.equal(result.forwarder.target_private_ip, "172.31.48.13");
    assert.equal(result.wait_error, undefined);
  });

  it("支援 Debian 13 映像（無 rootDeviceName 的 DescribeImages 回應）", async () => {
    const calls = [];
    const sleepDelays = [];
    let consoleOutputCalls = 0;
    const env = makeEnv({
      __testHooks: {
        sleep: async (delayMs) => {
          sleepDelays.push(delayMs);
        },
        fetch: async (url, init) => {
          calls.push({ url, init });
          const action = readAction(init);

          switch (action) {
            case "DescribeAvailabilityZones":
              return makeXmlResponse(OPTED_IN_ZONE_XML);
            case "DescribeInstanceTypeOfferings":
              return makeXmlResponse(OFFERINGS_XML);
            case "DescribeInstanceTypes":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <DescribeInstanceTypesResponse>
                  <instanceTypeSet>
                    <item>
                      <instanceType>t3.medium</instanceType>
                      <processorInfo>
                        <supportedArchitectures>
                          <item>x86_64</item>
                        </supportedArchitectures>
                      </processorInfo>
                    </item>
                  </instanceTypeSet>
                </DescribeInstanceTypesResponse>`);
            case "DescribeImages":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <DescribeImagesResponse>
                  <imagesSet>
                    <item>
                      <imageId>ami-new</imageId>
                      <name>debian-13-amd64-20240501-1111</name>
                      <creationDate>2024-05-01T00:00:00.000Z</creationDate>
                    </item>
                  </imagesSet>
                </DescribeImagesResponse>`);
            case "DescribeVpcs":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <DescribeVpcsResponse>
                  <vpcSet>
                    <item>
                      <vpcId>vpc-123</vpcId>
                      <cidrBlock>10.0.100.0/24</cidrBlock>
                      <isDefault>true</isDefault>
                    </item>
                  </vpcSet>
                </DescribeVpcsResponse>`);
            case "DescribeSubnets":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <DescribeSubnetsResponse>
                  <subnetSet>
                    <item>
                      <subnetId>subnet-123</subnetId>
                      <cidrBlock>10.0.100.0/26</cidrBlock>
                      <availabilityZone>eu-west-2-wl2-man-wlz-1</availabilityZone>
                      <vpcId>vpc-123</vpcId>
                    </item>
                  </subnetSet>
                </DescribeSubnetsResponse>`);
            case "DescribeSecurityGroups":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <DescribeSecurityGroupsResponse>
                  <securityGroupInfo>
                    <item>
                      <groupId>sg-123</groupId>
                      <groupName>managed-all-open</groupName>
                      <vpcId>vpc-123</vpcId>
                      <ipPermissions>
                        <item>
                          <ipProtocol>-1</ipProtocol>
                          <ipRanges>
                            <item><cidrIp>0.0.0.0/0</cidrIp></item>
                          </ipRanges>
                        </item>
                      </ipPermissions>
                      <ipPermissionsEgress>
                        <item>
                          <ipProtocol>-1</ipProtocol>
                          <ipRanges>
                            <item><cidrIp>0.0.0.0/0</cidrIp></item>
                          </ipRanges>
                        </item>
                      </ipPermissionsEgress>
                    </item>
                  </securityGroupInfo>
                </DescribeSecurityGroupsResponse>`);
            case "DescribeCarrierGateways":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <DescribeCarrierGatewaysResponse>
                  <carrierGatewaySet>
                    <item>
                      <carrierGatewayId>cagw-123</carrierGatewayId>
                      <vpcId>vpc-123</vpcId>
                      <state>available</state>
                    </item>
                  </carrierGatewaySet>
                </DescribeCarrierGatewaysResponse>`);
            case "DescribeRouteTables":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <DescribeRouteTablesResponse>
                  <routeTableSet>
                    <item>
                      <routeTableId>rtb-123</routeTableId>
                      <vpcId>vpc-123</vpcId>
                      <associationSet>
                        <item>
                          <routeTableAssociationId>rtbassoc-123</routeTableAssociationId>
                          <subnetId>subnet-123</subnetId>
                        </item>
                      </associationSet>
                      <routeSet>
                        <item>
                          <destinationCidrBlock>0.0.0.0/0</destinationCidrBlock>
                          <carrierGatewayId>cagw-123</carrierGatewayId>
                          <state>active</state>
                        </item>
                      </routeSet>
                    </item>
                  </routeTableSet>
                </DescribeRouteTablesResponse>`);
            case "RunInstances":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <RunInstancesResponse>
                  <instancesSet>
                    <item>
                      <instanceId>i-123</instanceId>
                    </item>
                  </instancesSet>
                </RunInstancesResponse>`);
            case "DescribeInstances":
              if (sleepDelays.length < 1) {
                return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                  <DescribeInstancesResponse>
                    <reservationSet>
                      <item>
                        <instancesSet>
                          <item>
                            <instanceId>i-123</instanceId>
                            <instanceState><name>pending</name></instanceState>
                          </item>
                        </instancesSet>
                      </item>
                    </reservationSet>
                  </DescribeInstancesResponse>`);
              }
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <DescribeInstancesResponse>
                  <reservationSet>
                    <item>
                      <instancesSet>
                        <item>
                          <instanceId>i-123</instanceId>
                          <instanceState><name>running</name></instanceState>
                          <privateIpAddress>10.0.100.10</privateIpAddress>
                          <privateDnsName>ip-10-0-100-10.eu-west-2.compute.internal</privateDnsName>
                          <dnsName>ec2-18-1-2-3.eu-west-2.compute.amazonaws.com</dnsName>
                        </item>
                      </instancesSet>
                    </item>
                  </reservationSet>
                </DescribeInstancesResponse>`);
            case "DescribeInstanceStatus":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <DescribeInstanceStatusResponse>
                  <instanceStatusSet>
                    <item>
                      <instanceId>i-123</instanceId>
                      <instanceStatus><status>ok</status></instanceStatus>
                      <systemStatus><status>ok</status></systemStatus>
                    </item>
                  </instanceStatusSet>
                </DescribeInstanceStatusResponse>`);
            case "GetConsoleOutput":
              consoleOutputCalls += 1;
              if (consoleOutputCalls === 1) {
                return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                  <GetConsoleOutputResponse>
                    <instanceId>i-123</instanceId>
                    <output>${Buffer.from("booting").toString("base64")}</output>
                  </GetConsoleOutputResponse>`);
              }
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <GetConsoleOutputResponse>
                  <instanceId>i-123</instanceId>
                  <output>${Buffer.from(WAVELENGTH_CLOUD_INIT_MARKER).toString("base64")}</output>
                </GetConsoleOutputResponse>`);
            default:
              throw new Error(`Unexpected action ${action}`);
          }
        },
      },
    });

    const result = await deployWavelengthInstance(env, {
      region: "eu-west-2",
      zone: "eu-west-2-wl2-man-wlz-1",
      vpc_id: "vpc-123",
      instance_type: "t3.medium",
      os: "debian13",
    });

    assert.equal(result.instance_id, "i-123");
    assert.equal(result.state, "running");
    assert.equal(result.public_dns_name, "ec2-18-1-2-3.eu-west-2.compute.amazonaws.com");
    assert.equal(result.private_dns_name, "ip-10-0-100-10.eu-west-2.compute.internal");
    assert.equal(result.username, "root");
    assert.equal(result.ssh_command, "ssh root@ec2-18-1-2-3.eu-west-2.compute.amazonaws.com");
  });

  it("就緒檢查失敗時仍回傳啟動資訊與警告", async () => {
    const calls = [];
    const sleepDelays = [];
    const progressEvents = [];
    const env = makeEnv({
      __testHooks: {
        sleep: async (delayMs) => {
          sleepDelays.push(delayMs);
        },
        fetch: async (url, init) => {
          calls.push({ url, init });
          const action = readAction(init);

          switch (action) {
            case "DescribeAvailabilityZones":
              return makeXmlResponse(OPTED_IN_ZONE_XML);
            case "DescribeInstanceTypeOfferings":
              return makeXmlResponse(OFFERINGS_XML);
            case "DescribeInstanceTypes":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <DescribeInstanceTypesResponse>
                  <instanceTypeSet>
                    <item>
                      <instanceType>t3.medium</instanceType>
                      <processorInfo>
                        <supportedArchitectureSet>
                          <item>x86_64</item>
                        </supportedArchitectureSet>
                      </processorInfo>
                    </item>
                  </instanceTypeSet>
                </DescribeInstanceTypesResponse>`);
            case "DescribeImages":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <DescribeImagesResponse>
                  <imagesSet>
                    <item>
                      <imageId>ami-new</imageId>
                      <name>debian-12-amd64-20240501-1111</name>
                      <creationDate>2024-05-01T00:00:00.000Z</creationDate>
                    </item>
                  </imagesSet>
                </DescribeInstancesResponse>`);
            case "DescribeVpcs":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <DescribeVpcsResponse>
                  <vpcSet>
                    <item>
                      <vpcId>vpc-123</vpcId>
                      <cidrBlock>10.0.100.0/24</cidrBlock>
                      <isDefault>true</isDefault>
                    </item>
                  </vpcSet>
                </DescribeVpcsResponse>`);
            case "DescribeSubnets":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <DescribeSubnetsResponse>
                  <subnetSet>
                    <item>
                      <subnetId>subnet-123</subnetId>
                      <cidrBlock>10.0.100.0/26</cidrBlock>
                      <availabilityZone>eu-west-2-wl2-man-wlz-1</availabilityZone>
                      <vpcId>vpc-123</vpcId>
                    </item>
                  </subnetSet>
                </DescribeSubnetsResponse>`);
            case "DescribeSecurityGroups":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <DescribeSecurityGroupsResponse>
                  <securityGroupInfo>
                    <item>
                      <groupId>sg-123</groupId>
                      <groupName>managed-all-open</groupName>
                      <vpcId>vpc-123</vpcId>
                      <ipPermissions>
                        <item>
                          <ipProtocol>-1</ipProtocol>
                          <ipRanges>
                            <item><cidrIp>0.0.0.0/0</cidrIp></item>
                          </ipRanges>
                        </item>
                      </ipPermissions>
                      <ipPermissionsEgress>
                        <item>
                          <ipProtocol>-1</ipProtocol>
                          <ipRanges>
                            <item><cidrIp>0.0.0.0/0</cidrIp></item>
                          </ipRanges>
                        </item>
                      </ipPermissionsEgress>
                    </item>
                  </securityGroupInfo>
                </DescribeSecurityGroupsResponse>`);
            case "DescribeCarrierGateways":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <DescribeCarrierGatewaysResponse>
                  <carrierGatewaySet>
                    <item>
                      <carrierGatewayId>cagw-123</carrierGatewayId>
                      <vpcId>vpc-123</vpcId>
                      <state>available</state>
                    </item>
                  </carrierGatewaySet>
                </DescribeCarrierGatewaysResponse>`);
            case "DescribeRouteTables":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <DescribeRouteTablesResponse>
                  <routeTableSet>
                    <item>
                      <routeTableId>rtb-123</routeTableId>
                      <vpcId>vpc-123</vpcId>
                      <associationSet>
                        <item>
                          <routeTableAssociationId>rtbassoc-123</routeTableAssociationId>
                          <subnetId>subnet-123</subnetId>
                        </item>
                      </associationSet>
                      <routeSet>
                        <item>
                          <destinationCidrBlock>0.0.0.0/0</destinationCidrBlock>
                          <carrierGatewayId>cagw-123</carrierGatewayId>
                          <state>active</state>
                        </item>
                      </routeSet>
                    </item>
                  </routeTableSet>
                </DescribeRouteTablesResponse>`);
            case "RunInstances":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <RunInstancesResponse>
                  <instancesSet>
                    <item>
                      <instanceId>i-123</instanceId>
                    </item>
                  </instancesSet>
                </RunInstancesResponse>`);
            case "DescribeInstances":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <DescribeInstancesResponse>
                  <reservationSet>
                    <item>
                      <instancesSet>
                        <item>
                          <instanceId>i-123</instanceId>
                          <instanceState><name>pending</name></instanceState>
                        </item>
                      </instancesSet>
                    </item>
                  </reservationSet>
                </DescribeInstancesResponse>`);
            default:
              throw new Error(`Unexpected action ${action} ${url}`);
          }
        },
      },
    });

    const result = await deployWavelengthInstance(env, {
      region: "eu-west-2",
      zone: "eu-west-2-wl2-man-wlz-1",
      vpc_id: "vpc-123",
      instance_type: "t3.medium",
      os: "debian12",
    }, (stage, details = {}) => {
      progressEvents.push({ stage, ...details });
    });

    assert.equal(result.ready, false);
    assert.equal(result.instance_id, "i-123");
    assert.equal(result.state, "launched");
    assert.equal(result.subnet_id, "subnet-123");
    assert.equal(result.carrier_gateway_id, "cagw-123");
    assert.equal(result.route_table_id, "rtb-123");
    assert.equal(result.username, "root");
    assert.match(result.password, /[A-Z]/);
    assert.equal(progressEvents.some((event) =>
      event.stage === "root_password_generated" &&
      event.username === "root" &&
      event.password === result.password
    ), true);
    assert.equal(result.ssh_command, "");
    assert.match(result.warning, /已啟動/);
    assert.match(result.warning, /就緒檢查未完成/);
    assert.match(result.wait_error, /running/i);
    assert.equal(calls.filter((call) => readAction(call.init) === "DescribeInstances").length, 60);
    assert.equal(sleepDelays.length, 59);
    assert.ok(sleepDelays.every((delayMs) => delayMs === 5000));
  });

  it("Zone 尚未初始化時部署失敗並提示初始化", async () => {
    const env = makeEnv({
      __testHooks: {
        fetch: async (url, init) => {
          const action = readAction(init);
          switch (action) {
            case "DescribeAvailabilityZones":
              return makeXmlResponse(OPTED_IN_ZONE_XML);
            case "DescribeInstanceTypeOfferings":
              return makeXmlResponse(OFFERINGS_XML);
            case "DescribeInstanceTypes":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <DescribeInstanceTypesResponse>
                  <instanceTypeSet>
                    <item>
                      <instanceType>t3.medium</instanceType>
                      <processorInfo>
                        <supportedArchitectureSet>
                          <item>x86_64</item>
                        </supportedArchitectureSet>
                      </processorInfo>
                    </item>
                  </instanceTypeSet>
                </DescribeInstanceTypesResponse>`);
            case "DescribeImages":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <DescribeImagesResponse>
                  <imagesSet>
                    <item>
                      <imageId>ami-new</imageId>
                      <name>debian-12-amd64-20240501-1111</name>
                      <creationDate>2024-05-01T00:00:00.000Z</creationDate>
                    </item>
                  </imagesSet>
                </DescribeImagesResponse>`);
            case "DescribeVpcs":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <DescribeVpcsResponse>
                  <vpcSet>
                    <item>
                      <vpcId>vpc-123</vpcId>
                      <cidrBlock>10.0.100.0/24</cidrBlock>
                      <isDefault>true</isDefault>
                    </item>
                  </vpcSet>
                </DescribeVpcsResponse>`);
            case "DescribeSubnets":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <DescribeSubnetsResponse>
                  <subnetSet></subnetSet>
                </DescribeSubnetsResponse>`);
            default:
              throw new Error(`Unexpected action ${action} ${url}`);
          }
        },
      },
    });

    await assert.rejects(
      () =>
        deployWavelengthInstance(env, {
          region: "eu-west-2",
          zone: "eu-west-2-wl2-man-wlz-1",
          vpc_id: "vpc-123",
          instance_type: "t3.medium",
          os: "debian12",
        }),
      /子網尚未初始化/,
    );
  });
});

// ── deployRegionalEc2Instance ───────────────────────────────

describe("deployRegionalEc2Instance", () => {
  it("預設啟動 t3.nano 公網 EC2 並套用共用密碼與安全群組邏輯", async () => {
    const calls = [];
    const progressEvents = [];
    const env = makeEnv({
      __testHooks: {
        sleep: async () => {},
        fetch: async (url, init) => {
          calls.push({ url, init });
          const action = readAction(init);

          switch (action) {
            case "DescribeInstanceTypes":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <DescribeInstanceTypesResponse>
                  <instanceTypeSet>
                    <item>
                      <instanceType>t3.nano</instanceType>
                      <processorInfo>
                        <supportedArchitectureSet>
                          <item>x86_64</item>
                        </supportedArchitectureSet>
                      </processorInfo>
                    </item>
                  </instanceTypeSet>
                </DescribeInstanceTypesResponse>`);
            case "DescribeImages":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <DescribeImagesResponse>
                  <imagesSet>
                    <item>
                      <imageId>ami-new</imageId>
                      <name>debian-12-amd64-20240501-1111</name>
                      <creationDate>2024-05-01T00:00:00.000Z</creationDate>
                      <rootDeviceName>/dev/sda1</rootDeviceName>
                      <blockDeviceMapping>
                        <item>
                          <deviceName>/dev/sda1</deviceName>
                          <ebs><snapshotId>snap-new</snapshotId></ebs>
                        </item>
                      </blockDeviceMapping>
                    </item>
                  </imagesSet>
                </DescribeImagesResponse>`);
            case "DescribeVpcs":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <DescribeVpcsResponse>
                  <vpcSet>
                    <item>
                      <vpcId>vpc-123</vpcId>
                      <cidrBlock>10.0.100.0/24</cidrBlock>
                      <isDefault>true</isDefault>
                    </item>
                  </vpcSet>
                </DescribeVpcsResponse>`);
            case "DescribeSubnets":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <DescribeSubnetsResponse>
                  <subnetSet>
                    <item>
                      <subnetId>subnet-regional</subnetId>
                      <cidrBlock>10.0.100.64/26</cidrBlock>
                      <availabilityZone>eu-west-2a</availabilityZone>
                      <vpcId>vpc-123</vpcId>
                    </item>
                  </subnetSet>
                </DescribeSubnetsResponse>`);
            case "DescribeSecurityGroups":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <DescribeSecurityGroupsResponse>
                  <securityGroupInfo>
                    <item>
                      <groupId>sg-123</groupId>
                      <vpcId>vpc-123</vpcId>
                      <ipPermissions>
                        <item>
                          <ipProtocol>-1</ipProtocol>
                          <ipRanges><item><cidrIp>0.0.0.0/0</cidrIp></item></ipRanges>
                        </item>
                      </ipPermissions>
                      <ipPermissionsEgress>
                        <item>
                          <ipProtocol>-1</ipProtocol>
                          <ipRanges><item><cidrIp>0.0.0.0/0</cidrIp></item></ipRanges>
                        </item>
                      </ipPermissionsEgress>
                    </item>
                  </securityGroupInfo>
                </DescribeSecurityGroupsResponse>`);
            case "CreateTags":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <CreateTagsResponse><return>true</return></CreateTagsResponse>`);
            case "RunInstances":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <RunInstancesResponse>
                  <instancesSet>
                    <item><instanceId>i-regional</instanceId></item>
                  </instancesSet>
                </RunInstancesResponse>`);
            case "DescribeInstances":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <DescribeInstancesResponse>
                  <reservationSet>
                    <item>
                      <instancesSet>
                        <item>
                          <instanceId>i-regional</instanceId>
                          <instanceState><name>running</name></instanceState>
                          <privateIpAddress>10.0.100.70</privateIpAddress>
                          <privateDnsName>ip-10-0-100-70.eu-west-2.compute.internal</privateDnsName>
                          <dnsName>ec2-18-4-5-6.eu-west-2.compute.amazonaws.com</dnsName>
                        </item>
                      </instancesSet>
                    </item>
                  </reservationSet>
                </DescribeInstancesResponse>`);
            case "DescribeInstanceStatus":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <DescribeInstanceStatusResponse>
                  <instanceStatusSet>
                    <item>
                      <instanceStatus><status>ok</status></instanceStatus>
                      <systemStatus><status>ok</status></systemStatus>
                    </item>
                  </instanceStatusSet>
                </DescribeInstanceStatusResponse>`);
            case "GetConsoleOutput":
              return makeXmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
                <GetConsoleOutputResponse>
                  <output>${Buffer.from(WAVELENGTH_CLOUD_INIT_MARKER).toString("base64")}</output>
                </GetConsoleOutputResponse>`);
            default:
              throw new Error(`Unexpected action ${action} ${url}`);
          }
        },
      },
    });

    const result = await deployRegionalEc2Instance(
      env,
      {
        region: "eu-west-2",
        vpc_id: "vpc-123",
        regional_instance_type: "t3.medium",
        os: "debian12",
      },
      (stage, details = {}) => {
        progressEvents.push({ stage, ...details });
      },
    );

    const runCall = calls.find((call) => readAction(call.init) === "RunInstances");
    const runParams = new URLSearchParams(String(runCall.init.body));
    const userData = Buffer.from(runParams.get("UserData"), "base64").toString("utf8");

    assert.equal(runParams.get("InstanceType"), "t3.nano");
    assert.equal(runParams.get("NetworkInterface.1.SubnetId"), "subnet-regional");
    assert.equal(runParams.get("NetworkInterface.1.AssociatePublicIpAddress"), "true");
    assert.equal(runParams.get("NetworkInterface.1.SecurityGroupId.1"), "sg-123");
    assert.equal(runParams.get("NetworkInterface.1.AssociateCarrierIpAddress"), null);
    assert.match(userData, /ssh_pwauth: true/);
    assert.match(userData, /PermitRootLogin yes/);
    assert.match(userData, new RegExp(WAVELENGTH_CLOUD_INIT_MARKER));
    assert.equal(progressEvents.some((event) =>
      event.stage === "root_password_generated" &&
      event.username === "root" &&
      event.password === result.password
    ), true);
    assert.equal(result.instance_id, "i-regional");
    assert.equal(result.security_group_id, "sg-123");
    assert.equal(result.subnet_id, "subnet-regional");
    assert.equal(result.username, "root");
    assert.match(result.password, /[A-Z]/);
    assert.equal(result.ssh_command, "ssh root@ec2-18-4-5-6.eu-west-2.compute.amazonaws.com");
    assert.ok(
      progressEvents.some(
        (event) =>
          event.stage === "status_check_progress" &&
          event.attempt === 1 &&
          event.max_attempts === 60 &&
          event.instance_status === "ok" &&
          event.system_status === "ok",
      ),
    );
  });
});

import type { MessageCatalog } from '../messages.types';

/**
 * Simplified Chinese (`zh-CN`) message catalog (T9.2).
 *
 * Typed as {@link MessageCatalog}, so it MUST mirror every key in
 * `../en/messages.ts`; TypeScript fails the build if a key is missing
 * (satisfies T9.2 acceptance). Runtime fallback chain is `zh-CN → en`
 * (see `../index.ts`).
 *
 * Interpolation tokens (e.g. `{min}`, `{max}`) are preserved verbatim.
 */
export const zhCN: MessageCatalog = {
  common: {
    appName: '雪上学校',
    portal: '教练门户',
    loading: '加载中…',
    save: '保存',
    cancel: '取消',
    edit: '编辑',
    delete: '删除',
    confirm: '确认',
    back: '返回',
    next: '下一步',
    submit: '提交',
    search: '搜索',
    yes: '是',
    no: '否',
    language: '语言',
    languageEnglish: '英语',
    languageChinese: '简体中文',
    statusPending: '待审核',
    statusApproved: '已通过',
    statusRejected: '已拒绝',
    statusDeactivated: '已停用',
  },
  auth: {
    signInTitle: '登录',
    signUpTitle: '创建账户',
    emailLabel: '电子邮箱',
    passwordLabel: '密码',
    signInButton: '登录',
    signUpButton: '注册',
    signOut: '退出登录',
    forgotPassword: '忘记密码？',
    verifyEmailTitle: '验证您的邮箱',
    verifyEmailBody: '我们已向您的邮箱发送了验证链接，请打开以激活您的账户。',
    resendVerification: '重新发送验证邮件',
    emailNotVerified: '请先验证您的电子邮箱地址以继续。',
  },
  profile: {
    title: '我的资料',
    displayName: '显示名称',
    bio: '个人简介',
    bioPlaceholder: '向合作伙伴介绍您的经验和教学风格…',
    preferredLanguage: '首选语言',
    dateOfBirth: '出生日期',
    certifications: '认证资格',
    disciplines: '项目',
    teachingLocations: '教学地点',
    courseLevels: '课程级别',
    photo: '头像',
    uploadPhoto: '上传头像',
    saveSuccess: '您的资料已保存。',
    saveError: '无法保存您的资料，请重试。',
  },
  error: {
    unauthorized: '您必须登录后才能执行此操作。',
    forbidden: '您没有执行此操作的权限。',
    notFound: '未找到请求的项目。',
    validation: '您提供的部分信息无效。',
    conflict: '此操作与记录的当前状态冲突。',
    rateLimited: '请求过于频繁，请稍后再试。',
    internal: '我们这边出现了问题，请稍后再试。',
    emailNotVerified: '您的电子邮箱地址尚未验证。',
    profileNotApproved: '您的资料尚未通过审核。',
  },
  validation: {
    required: '此字段为必填项。',
    email: '请输入有效的电子邮箱地址。',
    minLength: '请至少输入 {min} 个字符。',
    maxLength: '请输入不超过 {max} 个字符。',
    invalidDate: '请输入有效的日期。',
    invalidLanguage: '请选择受支持的语言。',
    invalidUuid: '提供的标识符无效。',
  },
  emptyState: {
    noCertifications: '尚未添加认证资格。',
    noDisciplines: '尚未选择项目。',
    noLocations: '尚未选择教学地点。',
    noResults: '未找到结果。',
  },
  email: {
    layout: {
      greeting: '{name}，您好：',
      greetingNoName: '您好：',
      signoffLead: '祝好，',
      signoffTeam: 'SSnow团队',
      buttonFallback: '如果按钮无法点击，请将下面的链接复制到浏览器中打开：',
      buttonLine: '{label}：{url}',
      codeLabel: '或输入以下验证码：',
      footerClub: 'Serendipity Snow Club',
      footerQuestions:
        '有任何问题，直接回复这封邮件，或发送邮件至 info@ssnow.club',
    },
    approved: {
      subject: '您的教练资料已通过审核',
      preheader: '您的教练资料已通过审核。',
      heading: '资料审核已通过',
      paragraphs: [
        '好消息！我们已经审核了您的教练资料，并已通过。欢迎加入我们！',
        '您可以随时登录教练平台，更新个人信息、证书和照片。',
      ],
      button: '登录',
      finePrint: '您收到这封邮件，是因为您在 SSnow 有教练资料。',
    },
    rejected: {
      subject: '关于您的教练申请',
      preheader: '关于您在 SSnow 的教练资料。',
      heading: '关于您的申请',
      paragraphs: [
        '感谢您申请加入 SSnow 教练团队，也感谢您花时间认真填写资料。',
        '经过审核，我们暂时无法通过您的教练资料。',
      ],
      reasonLabel: '团队备注：',
      closing:
        '如有疑问，或想补充更多教学经历，直接回复这封邮件就好，我们很乐意和您聊聊。',
      finePrint: '您收到这封邮件，是因为您申请成为 SSnow 的教练。',
    },
    deactivated: {
      subject: '您的教练资料已停用',
      preheader: '您的资料将不再显示在我们的网站上。',
      heading: '资料已停用',
      paragraphs: [
        '您的教练资料已设为停用，将不再显示在 SSnow 网站上。',
        '如果您认为这是误操作，或希望重新启用，直接回复这封邮件告诉我们即可。',
      ],
      finePrint: '您收到这封邮件，是因为您在 SSnow 有教练资料。',
    },
    reactivated: {
      subject: '您的教练资料已重新启用',
      preheader: '欢迎回到 SSnow。',
      heading: '欢迎回来',
      paragraphs: [
        '好消息！您的教练资料已重新启用。',
        '不妨现在登录看看，确认个人信息、证书和照片都是最新的。',
      ],
      button: '登录',
      finePrint: '您收到这封邮件，是因为您在 SSnow 有教练资料。',
    },
    auth: {
      confirmSignup: {
        subject: '请确认您的邮箱地址',
        preheader: '只差一步，即可完成账户注册。',
        heading: '确认您的邮箱',
        paragraphs: [
          '感谢注册！请确认您的邮箱地址，完成账户创建。链接 1 小时内有效。',
        ],
        button: '确认邮箱',
        finePrint: '如果您没有注册过账户，请忽略这封邮件。',
      },
      recovery: {
        subject: '重置您的 SSnow 密码',
        preheader: '为您的账户设置新密码。',
        heading: '重置密码',
        paragraphs: [
          '我们收到了重置您账户密码的请求。点击下方按钮即可设置新密码，链接 1 小时内有效。',
        ],
        button: '重置密码',
        finePrint: '如果这不是您本人的操作，请忽略这封邮件，您的密码不会改变。',
      },
      magicLink: {
        subject: '您的 SSnow 登录链接',
        preheader: '一键登录您的账户。',
        heading: '登录 SSnow',
        paragraphs: [
          '点击下方按钮即可登录。链接 1 小时内有效，且只能使用一次。',
        ],
        button: '登录',
        finePrint: '如果您没有申请登录链接，请忽略这封邮件。',
      },
      invite: {
        subject: '邀请您加入 SSnow',
        preheader: '设置您的教练平台账户。',
        heading: '诚邀您加入',
        paragraphs: [
          '我们诚邀您在 SSnow 教练平台创建账户。',
          '点击下方按钮接受邀请，完成账户设置。',
        ],
        button: '接受邀请',
        finePrint: '如果您没有预期会收到这封邀请，请忽略这封邮件。',
      },
      emailChange: {
        subject: '请确认您的新邮箱地址',
        preheader: '确认更改账户邮箱。',
        heading: '确认更换邮箱',
        paragraphs: [
          '我们收到了将您的 SSnow 账户邮箱更改为 {newEmail} 的请求。',
          '请点击下方按钮确认更改。',
        ],
        button: '确认更改',
        finePrint:
          '如果这不是您本人的操作，请立即回复这封邮件，我们会协助您保护账户安全。',
      },
      reauthentication: {
        subject: '您的 SSnow 验证码',
        preheader: '您的一次性验证码。',
        heading: '确认是您本人',
        paragraphs: ['请输入以下验证码，确认是您本人操作：'],
        finePrint:
          '如果您没有申请验证码，请忽略这封邮件。请勿将验证码告诉任何人。',
      },
      passwordChanged: {
        subject: '您的 SSnow 密码已更改',
        preheader: '关于您账户的安全提醒。',
        heading: '密码已更改',
        paragraphs: [
          '您的 SSnow 账户密码刚刚已更改。',
          '如果是您本人操作，无需任何处理；如果不是，请立即回复这封邮件，我们会协助您保护账户安全。',
        ],
        finePrint: '您收到这封安全提醒，是因为您的账户密码发生了变更。',
      },
      emailChanged: {
        subject: '您的 SSnow 账户邮箱已更改',
        preheader: '关于您账户的安全提醒。',
        heading: '账户邮箱已更改',
        paragraphs: [
          '您的 SSnow 账户邮箱已从 {oldEmail} 更改为 {newEmail}。',
          '如果是您本人操作，无需任何处理；如果不是，请立即回复这封邮件，我们会协助您保护账户安全。',
        ],
        finePrint:
          '您的账户邮箱发生了变更，因此我们将这封安全提醒发送到您之前的邮箱。',
      },
      phoneChanged: {
        subject: '您的 SSnow 账户手机号已更改',
        preheader: '关于您账户的安全提醒。',
        heading: '手机号已更改',
        paragraphs: [
          '您的 SSnow 账户手机号刚刚已更改。',
          '如果是您本人操作，无需任何处理；如果不是，请立即回复这封邮件，我们会协助您保护账户安全。',
        ],
        finePrint: '您收到这封安全提醒，是因为您的账户手机号发生了变更。',
      },
      identityLinked: {
        subject: '您的账户新增了一种登录方式',
        preheader: '关于您账户的安全提醒。',
        heading: '已新增登录方式',
        paragraphs: [
          '您的 SSnow 账户已关联新的登录方式（{provider}）。',
          '如果是您本人操作，无需任何处理；如果不是，请立即回复这封邮件，我们会协助您保护账户安全。',
        ],
        finePrint: '您收到这封安全提醒，是因为您账户的登录方式发生了变更。',
      },
      identityUnlinked: {
        subject: '您的账户移除了一种登录方式',
        preheader: '关于您账户的安全提醒。',
        heading: '已移除登录方式',
        paragraphs: [
          '您的 SSnow 账户已移除一种登录方式（{provider}）。',
          '如果是您本人操作，无需任何处理；如果不是，请立即回复这封邮件，我们会协助您保护账户安全。',
        ],
        finePrint: '您收到这封安全提醒，是因为您账户的登录方式发生了变更。',
      },
      mfaEnrolled: {
        subject: '您的账户已添加两步验证',
        preheader: '关于您账户的安全提醒。',
        heading: '已添加两步验证',
        paragraphs: [
          '您的 SSnow 账户已添加新的两步验证方式（{factorType}）。',
          '如果是您本人操作，无需任何处理；如果不是，请立即回复这封邮件，我们会协助您保护账户安全。',
        ],
        finePrint: '您收到这封安全提醒，是因为您账户的两步验证设置发生了变更。',
      },
      mfaUnenrolled: {
        subject: '您的账户已移除两步验证',
        preheader: '关于您账户的安全提醒。',
        heading: '已移除两步验证',
        paragraphs: [
          '您的 SSnow 账户已移除一种两步验证方式（{factorType}）。',
          '如果是您本人操作，无需任何处理；如果不是，请立即回复这封邮件，我们会协助您保护账户安全。',
        ],
        finePrint: '您收到这封安全提醒，是因为您账户的两步验证设置发生了变更。',
      },
      generic: {
        subject: '关于您的 SSnow 账户',
        preheader: '有关您账户的最新消息。',
        heading: '关于您的账户',
        paragraphs: ['我们收到了一项与您的 SSnow 账户相关的请求。'],
        linkParagraph:
          '如果是您本人操作，请点击下方按钮继续。链接 1 小时内有效。',
        button: '继续',
        finePrint:
          '如果这不是您本人的操作，请忽略这封邮件，或回复这封邮件，我们会协助您保护账户安全。',
      },
    },
    invite: {
      season: {
        subject: '您的 {season} 雪季 SSnow 教练账户已开通',
        preheader: '激活账户，设置您自己的密码。',
        heading: '激活您的教练账户',
        paragraphs: [
          '我们已为您开通 SSnow {season} 雪季的教练账户。',
          '点击下方按钮激活账户，并设置您自己的密码。之后请花几分钟核对一下个人资料、证书和教学地点。',
        ],
        button: '激活我的账户',
        finePrint:
          '此链接仅供您本人使用，{validDays} 天内有效。如果链接过期，可以在打开的页面上申请新的链接。',
      },
      reminder: {
        subject: '提醒：请激活您的 SSnow 教练账户',
        preheader: '您的教练账户还在等您激活。',
        heading: '您的账户在等待您的激活',
        paragraphs: [
          '温馨提醒：您 {season} 雪季的教练账户已经开通，但还没有激活。',
          '只需一分钟：点击下方按钮，设置密码即可。',
        ],
        button: '激活我的账户',
        finePrint:
          '这是一条新的激活链接，{validDays} 天内有效。如果链接过期，可以在打开的页面上申请新的链接。',
      },
    },
    certification: {
      labels: {
        regular: '{org} {level} 级',
        park: '{org} 公园 {level} 级',
        carving: '{org} 刻滑 {level} 级',
      },
      unleveledLabels: {
        regular: '{org}',
        park: '{org} 公园',
        carving: '{org} 刻滑',
      },
      expiring: {
        subject: '您的 {certification} 证书将于 {validUntil} 到期',
        preheader: '请上传续期后的证书，以便继续安排教学。',
        heading: '您的证书即将到期',
        paragraphs: [
          '您教练资料中的 {certification} 证书有效期至 {validUntil}。',
          '续费会员后，请在教练平台上传新的证书，以便我们继续为您安排课程。',
        ],
        button: '上传续期证书',
        finePrint: '如果您已经上传了续期后的证书，请忽略这封邮件。',
      },
      expired: {
        subject: '您的 {certification} 证书已过期',
        preheader: '请上传续期后的证书，以便继续教学。',
        heading: '您的证书已过期',
        paragraphs: [
          '您教练资料中的 {certification} 证书有效期至 {validUntil}，现已过期。',
          '请续费会员，并在教练平台上传新的证书。',
        ],
        button: '上传新证书',
        finePrint: '如果您已经上传了续期后的证书，请忽略这封邮件。',
      },
      rejected: {
        subject: '请重新上传您的 {certification} 证书',
        preheader: '我们无法接受您上传的证书。',
        heading: '您上传的证书未通过审核',
        paragraphs: [
          '我们审核了您上传的 {certification} 证书，但无法接受。',
          '请在教练平台上传一份清晰、有效的证书，以便我们核实您的资质。',
        ],
        reasonLabel: '团队备注：',
        button: '上传证书',
        finePrint: '您收到这封邮件，是因为您在 SSnow 的教练资料中上传了证书。',
      },
    },
    admin: {
      instructorPending: {
        subject: '新教练待审核：{instructorEmail}',
        preheader: '有一份新的教练资料等待您审核。',
        heading: '有新教练注册',
        paragraphs: [
          '{instructorEmail} 刚刚首次登录教练平台，新的教练资料正在等待审核。',
        ],
        button: '查看资料',
        finePrint: '您收到这封邮件，是因为您是 SSnow 的管理员。',
      },
    },
    documents: {
      assigned: {
        subject: '请完成您的入职资料',
        preheader: '请查看并完成您的入职资料。',
        heading: '您的入职资料',
        paragraphs: [
          '请在教练平台阅读并完成以下资料：',
          '只需几分钟，用手机也可以完成。',
        ],
        button: '查看我的资料',
        finePrint: '您收到这封邮件，是因为您是 SSnow 的教练。',
      },
      assignedOnApproval: {
        subject: '审核已通过：请完成入职资料',
        preheader: '您的 SSnow 教练资料已审核通过。',
        heading: '审核已通过',
        paragraphs: [
          '您的 SSnow 教练资料已审核通过。雪季开始前，请完成以下资料：',
          '只需几分钟，用手机也可以完成。',
        ],
        button: '开始入职',
        finePrint: '您收到这封邮件，是因为您是 SSnow 的教练。',
      },
      reminder: {
        subject: '提醒：您还有入职资料待完成',
        preheader: '您还有入职资料尚未完成。',
        heading: '还有资料待完成',
        paragraphs: [
          '温馨提醒：以下资料还在教练平台等您完成：',
          '请在第一节课之前完成。',
        ],
        button: '查看我的资料',
        finePrint:
          '您收到这封邮件，是因为您是 SSnow 的教练。我们每周最多发送一次提醒。',
      },
      completed: {
        subject: '您签署的文件：{title}',
        preheader: '附件是您签署的文件。',
        heading: '感谢您的签署',
        paragraphs: [
          '您已签署《{title}》。签署后的文件以 PDF 附件形式随本邮件发送。',
        ],
        fingerprintLabel: '附件 PDF 的 SHA-256：',
        button: '查看我的资料',
        finePrint:
          '请保留这封邮件。通过 SHA-256 可以核对附件在您签署后没有被改动。',
      },
      listItem: '{title}（{kind}）',
      kinds: { sign: '签署', read: '阅读' },
    },
  },
};

export default zhCN;
